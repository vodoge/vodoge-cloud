package proxy

// Turning stored configuration into something a client can actually dial.
//
// Everything else in this package is desired state that only the edge agent
// consumes. This file is the one place where the same rows are turned into a
// credential a person pastes into a browser or a scraper pool, which makes it
// the one place in the package that reads the password column at all.
//
// Two consequences follow, and both are load-bearing:
//
//   - The store interface used everywhere else deliberately cannot return a
//     password (Instance.Password is json:"-" and neither backend selects the
//     column). Export needs it, so it asks through a separate, narrower
//     interface — SecretStore — rather than widening the one every other
//     handler holds. A handler that never asks for secrets cannot leak them.
//   - Nothing here writes anywhere. It renders. Auditing, authorisation and
//     the decision to hand the bytes over live in the handler, where the
//     caller's identity is known.

import (
	"context"
	"database/sql"
	"encoding/csv"
	"fmt"
	"net"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/tenant"
)

// SecretStore is a Store that can also hand back the credentials it holds.
//
// Separate from Store on purpose. Store is what every proxy handler is given,
// and none of them may see a password; only the export handler asserts for
// this, so the set of code paths that can read the column is one function long
// and stays that way without anyone policing it.
type SecretStore interface {
	Store
	// InstanceSecrets maps instance id to the stored password. Instances with
	// no password are absent rather than mapped to "", so a caller cannot
	// confuse "not configured" with "configured empty".
	InstanceSecrets(ctx context.Context, tenantID string) (map[string]string, error)
}

// Endpoint is one listener rendered as something dialable.
type Endpoint struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	DeviceID  string `json:"device_id"`
	ModemIMEI string `json:"modem_imei"`
	Protocol  string `json:"protocol"`
	Host      string `json:"host"`
	Port      int    `json:"port"`
	Username  string `json:"username,omitempty"`
	// Password is serialised here, unlike on Instance. That is the entire
	// point of this type: an export a client cannot authenticate with is not
	// an export. Everything that decides who may hold one is in the handler.
	Password string `json:"password,omitempty"`
	// URL is the connection string, percent-encoded, ready to paste.
	URL string `json:"url"`
	// Enabled is what the tenant asked for, not what is listening. Whether the
	// listener is actually up is a device-reported fact the cloud does not
	// have here, so it is reported rather than used to filter: an operator who
	// just stopped a listener still wants its credential.
	Enabled bool `json:"enabled"`
}

// Unexportable is an instance no connection string can be written for.
//
// Reported rather than dropped. A silently shorter file is how an operator
// ends up believing a proxy does not exist, and the reason is always something
// they can act on.
type Unexportable struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Reason string `json:"reason"`
}

// wildcardHosts are the listen addresses that mean "every interface".
//
// They are correct in a listener and useless in a connection string: nothing
// dials 0.0.0.0. An export that emitted them would look like it worked and
// fail at the first connection, so they are refused with the fix in the
// message instead.
var wildcardHosts = map[string]bool{
	"0.0.0.0": true,
	"::":      true,
	"[::]":    true,
}

// Export renders instances as connection strings.
//
// host overrides the address clients should dial and is normally required: a
// listener bound to 0.0.0.0 knows every address it answers on and none of them
// is written down anywhere the cloud can see. When host is empty an instance
// bound to one concrete address still exports, because in that case the
// configuration does say where to dial.
//
// The two slices are returned separately rather than as one list with a status
// field so a caller cannot render a broken endpoint by forgetting to check.
func Export(
	instances []Instance,
	secrets map[string]string,
	host string,
) ([]Endpoint, []Unexportable, error) {
	host = strings.TrimSpace(host)
	if host != "" {
		if err := ValidateExportHost(host); err != nil {
			return nil, nil, err
		}
	}
	endpoints := []Endpoint{}
	skipped := []Unexportable{}
	for _, instance := range instances {
		dial := host
		if dial == "" {
			dial = strings.TrimSpace(instance.ListenAddr)
			if dial == "" || wildcardHosts[dial] {
				skipped = append(skipped, Unexportable{
					ID:   instance.ID,
					Name: instance.Name,
					Reason: "listens on every interface, so the configuration does not say " +
						"which address to dial; repeat the request with ?host=<address>",
				})
				continue
			}
			if err := ValidateExportHost(dial); err != nil {
				skipped = append(skipped, Unexportable{
					ID: instance.ID, Name: instance.Name,
					Reason: "stored listen address is not usable in a URL: " + err.Error(),
				})
				continue
			}
		}
		scheme := instance.Protocol
		if scheme == "" {
			scheme = "socks5"
		}
		endpoint := Endpoint{
			ID:        instance.ID,
			Name:      instance.Name,
			DeviceID:  instance.DeviceID,
			ModemIMEI: instance.ModemIMEI,
			Protocol:  scheme,
			Host:      dial,
			Port:      instance.ListenPort,
			Enabled:   instance.Enabled,
		}
		if instance.AuthEnabled {
			endpoint.Username = instance.Username
			endpoint.Password = secrets[instance.ID]
		}
		endpoint.URL = connectionString(endpoint)
		endpoints = append(endpoints, endpoint)
	}
	sort.SliceStable(endpoints, func(i, j int) bool { return endpoints[i].Name < endpoints[j].Name })
	sort.SliceStable(skipped, func(i, j int) bool { return skipped[i].Name < skipped[j].Name })
	return endpoints, skipped, nil
}

// connectionString builds the URL.
//
// net/url does the encoding rather than fmt: a password containing @ or / or a
// colon is legal and common, and a hand-built string breaks on it in a way
// that looks like a wrong password rather than a wrong export.
func connectionString(endpoint Endpoint) string {
	target := url.URL{
		Scheme: endpoint.Protocol,
		Host:   net.JoinHostPort(endpoint.Host, strconv.Itoa(endpoint.Port)),
	}
	switch {
	case endpoint.Username != "" && endpoint.Password != "":
		target.User = url.UserPassword(endpoint.Username, endpoint.Password)
	case endpoint.Username != "":
		// A username with no stored password. Emitting "user:@host" would
		// claim an empty password was configured; this says only what is known.
		target.User = url.User(endpoint.Username)
	}
	return target.String()
}

// ValidateExportHost checks an address before it is pasted into a URL.
//
// Not politeness. The result of this is handed to an operator who pastes it
// into a client without reading it, so a host carrying a path, a query, or its
// own userinfo would redirect that client somewhere else entirely while still
// looking like this deployment's export. Refusing anything that is not a bare
// host or IP literal is the cheapest way to make that impossible.
func ValidateExportHost(host string) error {
	if host == "" {
		return ErrInvalid{"host must not be empty"}
	}
	if len(host) > 253 {
		return ErrInvalid{"host is too long"}
	}
	if strings.HasPrefix(host, "[") {
		if !strings.HasSuffix(host, "]") || net.ParseIP(host[1:len(host)-1]) == nil {
			return ErrInvalid{"host looks like an IPv6 literal but does not parse"}
		}
		return nil
	}
	if strings.ContainsAny(host, " \t\r\n/@?#\\\"'%") {
		return ErrInvalid{"host must be a bare hostname or IP address, with no scheme, " +
			"port, credentials or path"}
	}
	if net.ParseIP(host) != nil {
		// A bare IPv6 address would need brackets to sit in a URL; ask for
		// them rather than adding them silently.
		if strings.Contains(host, ":") {
			return ErrInvalid{"an IPv6 host must be written in brackets, e.g. [2001:db8::1]"}
		}
		return nil
	}
	for _, label := range strings.Split(strings.TrimSuffix(host, "."), ".") {
		if label == "" || len(label) > 63 {
			return ErrInvalid{"host is not a valid hostname"}
		}
		for _, letter := range label {
			switch {
			case letter >= 'a' && letter <= 'z',
				letter >= 'A' && letter <= 'Z',
				letter >= '0' && letter <= '9',
				letter == '-', letter == '_':
			default:
				return ErrInvalid{"host is not a valid hostname"}
			}
		}
	}
	return nil
}

// RenderLines is the format a client can consume without a parser.
//
// One connection string per line, nothing else, so a whole file pastes into a
// scraper's proxy list and any single line pastes into a browser. Instances
// that could not be rendered follow as "#" comments — the conventional comment
// in every proxy list format there is — after the usable lines, so a consumer
// that reads until it stops understanding still gets everything usable.
func RenderLines(endpoints []Endpoint, skipped []Unexportable) string {
	var builder strings.Builder
	for _, endpoint := range endpoints {
		builder.WriteString(endpoint.URL)
		builder.WriteByte('\n')
	}
	for _, item := range skipped {
		builder.WriteString("# " + oneLine(item.Name) + ": " + oneLine(item.Reason) + "\n")
	}
	return builder.String()
}

// RenderCSV is the same data for a spreadsheet or a config generator.
func RenderCSV(endpoints []Endpoint, skipped []Unexportable) (string, error) {
	var builder strings.Builder
	writer := csv.NewWriter(&builder)
	rows := [][]string{{"name", "protocol", "host", "port", "username", "password", "url"}}
	for _, endpoint := range endpoints {
		rows = append(rows, []string{
			endpoint.Name, endpoint.Protocol, endpoint.Host,
			strconv.Itoa(endpoint.Port), endpoint.Username, endpoint.Password, endpoint.URL,
		})
	}
	for _, item := range skipped {
		// A row rather than a dropped line, for the same reason the comments
		// exist in the line format. The url column carries the reason because
		// a spreadsheet has nowhere else to put it and an empty url is what a
		// reader will look at first.
		rows = append(rows, []string{item.Name, "", "", "", "", "", "not exportable: " + item.Reason})
	}
	if err := writer.WriteAll(rows); err != nil {
		return "", err
	}
	writer.Flush()
	if err := writer.Error(); err != nil {
		return "", err
	}
	return builder.String(), nil
}

// oneLine keeps a name or a reason from breaking the line format.
//
// A name is operator-supplied and a newline in one would turn a comment into
// what looks like another connection string.
func oneLine(value string) string {
	return strings.NewReplacer("\r", " ", "\n", " ").Replace(value)
}

// AuditDetail describes an export without reproducing it.
//
// The audit log answers "who exported what, when". It must not answer "with
// which password", because an append-only log is read by more people, kept for
// longer and backed up to more places than the configuration it describes —
// copying a live credential into it turns one secret into several. Instance
// ids are enough to identify what left.
func AuditDetail(endpoints []Endpoint, skipped []Unexportable, format string) map[string]any {
	ids := make([]string, 0, len(endpoints))
	for _, endpoint := range endpoints {
		ids = append(ids, endpoint.ID)
	}
	return map[string]any{
		"format":       format,
		"exported":     len(endpoints),
		"unexportable": len(skipped),
		"instance_ids": ids,
	}
}

// InstanceSecrets reads the password column, which nothing else in this
// package does.
func (store SQL) InstanceSecrets(ctx context.Context, tenantID string) (map[string]string, error) {
	out := map[string]string{}
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `
			SELECT id::text, coalesce(password, '')
			  FROM app.proxy_instances`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id, password string
			if err := rows.Scan(&id, &password); err != nil {
				return err
			}
			if password != "" {
				out[id] = password
			}
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// InstanceSecrets is the in-memory equivalent, so a gateway without a database
// exports the same way one with a database does.
func (store *Memory) InstanceSecrets(_ context.Context, tenantID string) (map[string]string, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	out := map[string]string{}
	for _, item := range store.instances[tenantID] {
		if item.Password != "" {
			out[item.ID] = item.Password
		}
	}
	return out, nil
}

// compile-time proof that both stores can be exported from. Without these a
// missing method becomes a runtime type assertion that fails as a 503 in
// production, months later, on the one deployment nobody tested.
var (
	_ SecretStore = SQL{}
	_ SecretStore = (*Memory)(nil)
)

// ErrUnknownFormat names the formats that exist, because a caller who guessed
// wrong needs the list more than it needs the word "invalid".
func ErrUnknownFormat(format string) error {
	return ErrInvalid{fmt.Sprintf(
		"format %q is not one of lines, json, csv", format)}
}
