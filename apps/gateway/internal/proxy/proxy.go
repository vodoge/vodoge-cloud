// Package proxy holds the tenant's desired proxy configuration.
//
// The proxies run on the edge — a listener bound to one modem's interface, so
// traffic leaves over that SIM. Nothing here forwards a packet; it stores what
// should be running, hands it to the device, and keeps what the device reports
// back separate from what was asked for.
package proxy

import (
	"fmt"
	"net"
	"strconv"
	"strings"
)

// Upstream is a proxy the edge chains through.
type Upstream struct {
	ID       string         `json:"id"`
	Name     string         `json:"name"`
	Address  string         `json:"address"`
	Protocol string         `json:"protocol"`
	Username string         `json:"username"`
	Enabled  bool           `json:"enabled"`
	// Password is never serialised. The console writes it and never reads it
	// back, the same rule the settings secrets follow.
	Password string `json:"-"`
	// HasPassword lets the console show that one is stored without holding it.
	HasPassword bool           `json:"has_password"`
	LastProbe   map[string]any `json:"last_probe,omitempty"`
	LastProbeAt *int64         `json:"last_probe_at,omitempty"`
}

// Instance is one listener on one device.
type Instance struct {
	ID          string `json:"id"`
	DeviceID    string `json:"device_id"`
	Name        string `json:"name"`
	ModemIMEI   string `json:"modem_imei"`
	Protocol    string `json:"protocol"`
	ListenAddr  string `json:"listen_addr"`
	ListenPort  int    `json:"listen_port"`
	AuthEnabled bool   `json:"auth_enabled"`
	Username    string `json:"username"`
	Password    string `json:"-"`
	HasPassword bool   `json:"has_password"`
	UpstreamID  string `json:"upstream_id,omitempty"`
	Enabled     bool   `json:"enabled"`
}

// CountryRule binds a country to an upstream.
type CountryRule struct {
	CountryCode string `json:"country_code"`
	UpstreamID  string `json:"upstream_id,omitempty"`
}

// TrafficPoint is one instance's accounted traffic for one hour.
type TrafficPoint struct {
	InstanceID  string `json:"instance_id"`
	Hour        int64  `json:"hour"`
	BytesUp     int64  `json:"bytes_up"`
	BytesDown   int64  `json:"bytes_down"`
	Connections int64  `json:"connections"`
}

// ErrInvalid explains a rejected configuration.
type ErrInvalid struct{ Reason string }

func (err ErrInvalid) Error() string { return err.Reason }

// ValidateUpstream checks an upstream before it is stored.
func ValidateUpstream(upstream *Upstream) error {
	upstream.Name = strings.TrimSpace(upstream.Name)
	if upstream.Name == "" {
		return ErrInvalid{"name is required"}
	}
	if upstream.Protocol == "" {
		upstream.Protocol = "socks5"
	}
	if upstream.Protocol != "socks5" && upstream.Protocol != "http" {
		return ErrInvalid{"protocol must be socks5 or http"}
	}
	return validateHostPort(upstream.Address)
}

// ValidateInstance checks a listener before it is stored.
func ValidateInstance(instance *Instance) error {
	instance.Name = strings.TrimSpace(instance.Name)
	if instance.Name == "" {
		return ErrInvalid{"name is required"}
	}
	if instance.DeviceID == "" {
		return ErrInvalid{"device_id is required"}
	}
	if len(instance.ModemIMEI) != 15 || strings.Trim(instance.ModemIMEI, "0123456789") != "" {
		return ErrInvalid{"modem_imei must be 15 digits"}
	}
	if instance.Protocol == "" {
		instance.Protocol = "socks5"
	}
	if instance.Protocol != "socks5" && instance.Protocol != "http" {
		return ErrInvalid{"protocol must be socks5 or http"}
	}
	if instance.ListenAddr == "" {
		instance.ListenAddr = "0.0.0.0"
	}
	if net.ParseIP(instance.ListenAddr) == nil {
		return ErrInvalid{"listen_addr must be an IP address"}
	}
	if instance.ListenPort < 1 || instance.ListenPort > 65535 {
		return ErrInvalid{"listen_port must be between 1 and 65535"}
	}
	// A port below 1024 needs privileges the edge deliberately does not hold.
	if instance.ListenPort < 1024 {
		return ErrInvalid{"listen_port must be 1024 or above"}
	}
	if instance.AuthEnabled && strings.TrimSpace(instance.Username) == "" {
		return ErrInvalid{"username is required when auth is enabled"}
	}
	return nil
}

// ValidateCountryRule checks a country binding.
func ValidateCountryRule(rule *CountryRule) error {
	rule.CountryCode = strings.ToUpper(strings.TrimSpace(rule.CountryCode))
	if len(rule.CountryCode) != 2 {
		return ErrInvalid{"country_code must be two letters, e.g. CN"}
	}
	for _, letter := range rule.CountryCode {
		if letter < 'A' || letter > 'Z' {
			return ErrInvalid{"country_code must be two letters, e.g. CN"}
		}
	}
	return nil
}

func validateHostPort(address string) error {
	host, port, err := net.SplitHostPort(strings.TrimSpace(address))
	if err != nil {
		return ErrInvalid{"address must be host:port"}
	}
	if host == "" {
		return ErrInvalid{"address must be host:port"}
	}
	number, err := strconv.Atoi(port)
	if err != nil || number < 1 || number > 65535 {
		return ErrInvalid{fmt.Sprintf("port %q must be between 1 and 65535", port)}
	}
	return nil
}
