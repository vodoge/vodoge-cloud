package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/audit"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/commands"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/proxy"
)

// The proxy configuration endpoints.
//
// Everything here is desired state. The listeners run on the edge, bound to a
// modem's interface so traffic leaves over that SIM, which is not something a
// cloud host can do — it has no cellular interface. So the cloud stores what
// should be running and hands it to the device; what is actually listening is
// whatever the device last reported.
func (process *process) registerProxyRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/proxy/upstreams", process.listUpstreams)
	mux.HandleFunc("POST /v1/proxy/upstreams", process.saveUpstream)
	mux.HandleFunc("PUT /v1/proxy/upstreams/{id}", process.saveUpstream)
	mux.HandleFunc("DELETE /v1/proxy/upstreams/{id}", process.deleteUpstream)
	mux.HandleFunc("POST /v1/proxy/upstreams/{id}/probe", process.probeUpstream)

	mux.HandleFunc("GET /v1/proxy/instances", process.listInstances)
	mux.HandleFunc("POST /v1/proxy/instances", process.saveInstance)
	mux.HandleFunc("PUT /v1/proxy/instances/{id}", process.saveInstance)
	mux.HandleFunc("DELETE /v1/proxy/instances/{id}", process.deleteInstance)
	mux.HandleFunc("POST /v1/proxy/instances/{id}/{action}", process.instanceAction)

	mux.HandleFunc("GET /v1/proxy/country-rules", process.listCountryRules)
	mux.HandleFunc("PUT /v1/proxy/country-rules/{code}", process.saveCountryRule)
	mux.HandleFunc("DELETE /v1/proxy/country-rules/{code}", process.deleteCountryRule)

	mux.HandleFunc("GET /v1/proxy/traffic", process.listTraffic)
}

func (process *process) listUpstreams(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	list, err := process.proxies.Upstreams(request.Context(), entry.TenantID)
	if err != nil {
		http.Error(writer, "proxy configuration unavailable", http.StatusInternalServerError)
		return
	}
	writeJSON(writer, map[string]any{"upstreams": list})
}

func (process *process) saveUpstream(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	var upstream proxy.Upstream
	// Password is not a JSON field on the struct — it must never be written
	// out — so it is read from a shadow document.
	var withSecret struct {
		Password string `json:"password"`
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, 64<<10))
	if err != nil {
		http.Error(writer, "invalid upstream", http.StatusBadRequest)
		return
	}
	if err := json.Unmarshal(body, &upstream); err != nil {
		http.Error(writer, "invalid upstream", http.StatusBadRequest)
		return
	}
	_ = json.Unmarshal(body, &withSecret)
	upstream.Password = withSecret.Password
	if id := request.PathValue("id"); id != "" {
		upstream.ID = id
	}
	if err := proxy.ValidateUpstream(&upstream); err != nil {
		writeInvalid(writer, err)
		return
	}
	id, err := process.proxies.SaveUpstream(request.Context(), entry.TenantID, upstream)
	if err != nil {
		writeStoreError(writer, err, "upstream could not be saved")
		return
	}
	auditProxy(request, process, entry.TenantID, "proxy.upstream_saved", id)
	writeJSON(writer, map[string]any{"id": id})
}

func (process *process) deleteUpstream(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	id := request.PathValue("id")
	if err := process.proxies.DeleteUpstream(request.Context(), entry.TenantID, id); err != nil {
		writeStoreError(writer, err, "upstream could not be removed")
		return
	}
	auditProxy(request, process, entry.TenantID, "proxy.upstream_removed", id)
	writer.WriteHeader(http.StatusNoContent)
}

// probeUpstream asks a device to test an upstream from where it actually sits.
//
// The probe has to run on the edge: the question is whether that device can
// reach the proxy over its own network path, which a probe from the cloud
// would not answer.
func (process *process) probeUpstream(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	var body struct {
		DeviceID string `json:"device_id"`
	}
	_ = json.NewDecoder(io.LimitReader(request.Body, 4<<10)).Decode(&body)
	if body.DeviceID == "" {
		http.Error(writer, "device_id is required: a probe runs from a device", http.StatusBadRequest)
		return
	}
	id, err := process.queue.Enqueue(request.Context(), commands.Item{
		TenantID: entry.TenantID,
		DeviceID: body.DeviceID,
		Kind:     "probe_upstream_proxy",
		IdempotencyKey: "probe_upstream_proxy:" + body.DeviceID + ":" +
			strconv.FormatInt(time.Now().UnixNano(), 10),
		Payload: mustJSON(map[string]any{
			"kind":        "ProbeUpstreamProxy",
			"upstream_id": request.PathValue("id"),
		}),
		ExpiresAt: time.Now().Add(10 * time.Minute),
	})
	if err != nil {
		http.Error(writer, "command queue unavailable", http.StatusInternalServerError)
		return
	}
	auditProxy(request, process, entry.TenantID, "proxy.upstream_probed", request.PathValue("id"))
	writeJSON(writer, map[string]any{"id": id, "status": "queued"})
}

func (process *process) listInstances(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	list, err := process.proxies.Instances(
		request.Context(), entry.TenantID, request.URL.Query().Get("device_id"))
	if err != nil {
		http.Error(writer, "proxy configuration unavailable", http.StatusInternalServerError)
		return
	}
	writeJSON(writer, map[string]any{"instances": list})
}

func (process *process) saveInstance(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	var instance proxy.Instance
	var withSecret struct {
		Password string `json:"password"`
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, 64<<10))
	if err != nil {
		http.Error(writer, "invalid instance", http.StatusBadRequest)
		return
	}
	if err := json.Unmarshal(body, &instance); err != nil {
		http.Error(writer, "invalid instance", http.StatusBadRequest)
		return
	}
	_ = json.Unmarshal(body, &withSecret)
	instance.Password = withSecret.Password
	if id := request.PathValue("id"); id != "" {
		instance.ID = id
	}
	if err := proxy.ValidateInstance(&instance); err != nil {
		writeInvalid(writer, err)
		return
	}
	id, err := process.proxies.SaveInstance(request.Context(), entry.TenantID, instance)
	if err != nil {
		writeStoreError(writer, err, "instance could not be saved")
		return
	}
	auditProxy(request, process, entry.TenantID, "proxy.instance_saved", id)
	// The device is told immediately rather than at its next reconnect: a
	// configuration change nobody applied is indistinguishable from one that
	// failed, and the operator is watching the page right now.
	process.pushProxyConfig(request, entry.TenantID, instance.DeviceID)
	writeJSON(writer, map[string]any{"id": id})
}

func (process *process) deleteInstance(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	id := request.PathValue("id")
	// The device is looked up before the row goes, because afterwards there is
	// nothing left to say which device to tell.
	deviceID := ""
	if existing, err := process.proxies.Instances(request.Context(), entry.TenantID, ""); err == nil {
		for _, item := range existing {
			if item.ID == id {
				deviceID = item.DeviceID
			}
		}
	}
	if err := process.proxies.DeleteInstance(request.Context(), entry.TenantID, id); err != nil {
		writeStoreError(writer, err, "instance could not be removed")
		return
	}
	auditProxy(request, process, entry.TenantID, "proxy.instance_removed", id)
	if deviceID != "" {
		process.pushProxyConfig(request, entry.TenantID, deviceID)
	}
	writer.WriteHeader(http.StatusNoContent)
}

// instanceAction relays start, stop and restart to the device holding it.
func (process *process) instanceAction(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	action := request.PathValue("action")
	switch action {
	case "start", "stop", "restart":
	default:
		http.Error(writer, "action must be start, stop or restart", http.StatusBadRequest)
		return
	}
	id := request.PathValue("id")
	instances, err := process.proxies.Instances(request.Context(), entry.TenantID, "")
	if err != nil {
		http.Error(writer, "proxy configuration unavailable", http.StatusInternalServerError)
		return
	}
	deviceID := ""
	for _, item := range instances {
		if item.ID == id {
			deviceID = item.DeviceID
		}
	}
	if deviceID == "" {
		http.Error(writer, "no such instance", http.StatusNotFound)
		return
	}
	commandID, err := process.queue.Enqueue(request.Context(), commands.Item{
		TenantID: entry.TenantID,
		DeviceID: deviceID,
		Kind:     "proxy_lifecycle",
		IdempotencyKey: "proxy_lifecycle:" + id + ":" + action + ":" +
			strconv.FormatInt(time.Now().UnixNano(), 10),
		Payload: mustJSON(map[string]any{
			"kind":        "ProxyLifecycle",
			"instance_id": id,
			"action":      action,
		}),
		ExpiresAt: time.Now().Add(10 * time.Minute),
	})
	if err != nil {
		http.Error(writer, "command queue unavailable", http.StatusInternalServerError)
		return
	}
	auditProxy(request, process, entry.TenantID, "proxy.instance_"+action, id)
	writeJSON(writer, map[string]any{"id": commandID, "status": "queued"})
}

func (process *process) listCountryRules(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	list, err := process.proxies.CountryRules(request.Context(), entry.TenantID)
	if err != nil {
		http.Error(writer, "proxy configuration unavailable", http.StatusInternalServerError)
		return
	}
	writeJSON(writer, map[string]any{"country_rules": list})
}

func (process *process) saveCountryRule(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	var rule proxy.CountryRule
	if err := json.NewDecoder(io.LimitReader(request.Body, 4<<10)).Decode(&rule); err != nil {
		http.Error(writer, "invalid rule", http.StatusBadRequest)
		return
	}
	rule.CountryCode = request.PathValue("code")
	if err := proxy.ValidateCountryRule(&rule); err != nil {
		writeInvalid(writer, err)
		return
	}
	if err := process.proxies.SaveCountryRule(request.Context(), entry.TenantID, rule); err != nil {
		writeStoreError(writer, err, "rule could not be saved")
		return
	}
	auditProxy(request, process, entry.TenantID, "proxy.country_rule_saved", rule.CountryCode)
	writeJSON(writer, map[string]any{"country_code": rule.CountryCode})
}

func (process *process) deleteCountryRule(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	code := request.PathValue("code")
	if err := process.proxies.DeleteCountryRule(request.Context(), entry.TenantID, code); err != nil {
		writeStoreError(writer, err, "rule could not be removed")
		return
	}
	auditProxy(request, process, entry.TenantID, "proxy.country_rule_removed", code)
	writer.WriteHeader(http.StatusNoContent)
}

func (process *process) listTraffic(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	// A week by default: long enough to show a pattern, short enough that the
	// response stays a page rather than a download.
	hours := 24 * 7
	if raw := request.URL.Query().Get("hours"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil && parsed > 0 && parsed <= 24*90 {
			hours = parsed
		}
	}
	since := time.Now().Add(-time.Duration(hours) * time.Hour).Truncate(time.Hour)
	points, err := process.proxies.Traffic(request.Context(), entry.TenantID, since)
	if err != nil {
		http.Error(writer, "traffic unavailable", http.StatusInternalServerError)
		return
	}
	writeJSON(writer, map[string]any{"traffic": points, "since": since.UnixMilli()})
}

// pushProxyConfig hands a device its full desired configuration.
//
// The whole set rather than the one row that changed: the edge applies it by
// reconciling against what it is running, and a device that missed an earlier
// change would otherwise stay wrong forever.
func (process *process) pushProxyConfig(request *http.Request, tenantID, deviceID string) {
	instances, err := process.proxies.Instances(request.Context(), tenantID, deviceID)
	if err != nil {
		return
	}
	upstreams, err := process.proxies.Upstreams(request.Context(), tenantID)
	if err != nil {
		return
	}
	_, _ = process.queue.Enqueue(request.Context(), commands.Item{
		TenantID: tenantID,
		DeviceID: deviceID,
		Kind:     "configure_proxy",
		IdempotencyKey: "configure_proxy:" + deviceID + ":" +
			strconv.FormatInt(time.Now().UnixNano(), 10),
		Payload: mustJSON(map[string]any{
			"kind":      "ConfigureProxy",
			"instances": instances,
			"upstreams": upstreams,
		}),
		ExpiresAt: time.Now().Add(30 * time.Minute),
	})
}

func writeJSON(writer http.ResponseWriter, body any) {
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(writer).Encode(body)
}

func writeInvalid(writer http.ResponseWriter, err error) {
	var invalid proxy.ErrInvalid
	if errors.As(err, &invalid) {
		http.Error(writer, invalid.Reason, http.StatusBadRequest)
		return
	}
	http.Error(writer, "invalid request", http.StatusBadRequest)
}

// writeStoreError keeps a rejection the caller can fix out of the 500s.
func writeStoreError(writer http.ResponseWriter, err error, fallback string) {
	var invalid proxy.ErrInvalid
	if errors.As(err, &invalid) {
		http.Error(writer, invalid.Reason, http.StatusBadRequest)
		return
	}
	http.Error(writer, fallback, http.StatusInternalServerError)
}

func auditProxy(request *http.Request, process *process, tenantID, action, target string) {
	_ = process.audit.Append(request.Context(), tenantID, audit.Event{
		Actor:  "console",
		Action: action,
		Target: target,
	})
}

// mustJSON encodes a payload the gateway itself built. A failure here is a
// programming error, not a runtime condition, and an empty object is a
// payload the edge will reject clearly.
func mustJSON(value map[string]any) []byte {
	encoded, err := json.Marshal(value)
	if err != nil {
		return []byte(`{}`)
	}
	return encoded
}
