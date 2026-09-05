package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/audit"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/commands"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/ledger"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/matrix"
)

func (process *process) registerLedgerRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/support-ledger", process.listLedger)
	mux.HandleFunc("PUT /v1/support-ledger/{family}/{carrier}", process.writeLedger)
	mux.HandleFunc("DELETE /v1/support-ledger/{family}/{carrier}", process.deleteLedger)
	mux.HandleFunc("POST /v1/support-ledger/publish", process.publishLedger)
}

func (process *process) listLedger(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	list, err := process.ledger.List(request.Context(), entry.TenantID)
	if err != nil {
		http.Error(writer, "ledger unavailable", http.StatusInternalServerError)
		return
	}
	writeJSON(writer, map[string]any{"entries": list})
}

func (process *process) writeLedger(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	var item ledger.Entry
	if err := json.NewDecoder(io.LimitReader(request.Body, 8<<10)).Decode(&item); err != nil {
		http.Error(writer, "invalid ledger entry", http.StatusBadRequest)
		return
	}
	// The path wins over the body, for the same reason it does on a card
	// policy: two sources for one key is how a measurement is filed against a
	// pairing nobody took it on.
	item.ModemFamily = request.PathValue("family")
	item.Carrier = request.PathValue("carrier")
	if err := ledger.Validate(&item); err != nil {
		var invalid ledger.ErrInvalid
		if errors.As(err, &invalid) {
			http.Error(writer, invalid.Reason, http.StatusBadRequest)
			return
		}
		http.Error(writer, "invalid ledger entry", http.StatusBadRequest)
		return
	}
	if err := process.ledger.Save(request.Context(), entry.TenantID, item); err != nil {
		http.Error(writer, "ledger entry could not be saved", http.StatusInternalServerError)
		return
	}
	_ = process.audit.Append(request.Context(), entry.TenantID, audit.Event{
		Actor:  "console",
		Action: "ledger.measurement_recorded",
		Target: item.ModemFamily + " on " + item.Carrier,
	})
	writeJSON(writer, item)
}

func (process *process) deleteLedger(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	family := request.PathValue("family")
	carrier := request.PathValue("carrier")
	if err := process.ledger.Delete(request.Context(), entry.TenantID, family, carrier); err != nil {
		http.Error(writer, "ledger entry could not be removed", http.StatusInternalServerError)
		return
	}
	// Withdrawing a measurement takes a pairing back to untested, which stops
	// the fleet doing it. Audited for that reason rather than for tidiness.
	_ = process.audit.Append(request.Context(), entry.TenantID, audit.Event{
		Actor:  "console",
		Action: "ledger.measurement_withdrawn",
		Target: family + " on " + carrier,
	})
	writer.WriteHeader(http.StatusNoContent)
}

// publishLedger renders the ledger into a capability matrix and hands it to
// every device.
//
// Separate from saving, deliberately. Recording a measurement and changing
// what a fleet will attempt are two decisions, and collapsing them means a
// half-finished afternoon of testing reaches hardware the moment somebody
// saves a row. The version is derived from the content, so publishing an
// unchanged ledger is a no-op the devices recognise by digest.
// deviceList reads the cross-tenant catalogue, tolerating a deployment that
// has not wired one.
func (process *process) readCatalogue(ctx context.Context) ([]ledger.SupportedDevice, error) {
	if process.supportedDevices == nil {
		return nil, nil
	}
	return process.supportedDevices.ListSupportedDevices(ctx)
}

func (process *process) publishLedger(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	entries, err := process.ledger.List(request.Context(), entry.TenantID)
	if err != nil {
		http.Error(writer, "ledger unavailable", http.StatusInternalServerError)
		return
	}
	if len(entries) == 0 {
		// An empty ledger is "nothing is supported". That may well be true on
		// a fresh tenant, but pushing it is not how anybody would mean to say
		// it, so it has to be a deliberate act rather than a stray click.
		http.Error(writer, "the ledger is empty; nothing would be supported", http.StatusBadRequest)
		return
	}

	version := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	// 目录读不出来 → **整次发布作废**，而不是当成空的继续。
	//
	// 当成空的会渲染出「没有 [[device]] 段」的文档，边缘端读作 NotStated
	// 并放行 —— 也就是把闸 1 悄悄关掉了。一次数据库抖动不该有这个后果，
	// 而且发布是个明确动作，失败了让人重试就好。
	supported, err := process.readCatalogue(request.Context())
	if err != nil {
		http.Error(writer, "supported device list unavailable", http.StatusInternalServerError)
		return
	}
	rendered, err := json.Marshal(ledger.Document(version, entries, supported))
	if err != nil {
		http.Error(writer, "matrix could not be rendered", http.StatusInternalServerError)
		return
	}
	// Through the existing overlay rather than hashing the bytes here. The
	// digest the edge checks is taken over serde's BTreeMap ordering, and
	// `matrix.Parse` is the one place that re-encodes Go's map into it --
	// computing it a second way in this file would work until the day the two
	// disagreed, and then the push would be rejected with a digest mismatch
	// that pointed at nothing.
	overlay, err := matrix.Parse(rendered)
	if err != nil {
		http.Error(writer, "matrix could not be rendered", http.StatusInternalServerError)
		return
	}
	// Stored as well as sent, so `app.capability_matrix` holds what the fleet
	// was actually given rather than staying empty while devices run something
	// nobody can read back.
	if err := process.matrix.Put(request.Context(), entry.TenantID, overlay); err != nil {
		http.Error(writer, "matrix could not be stored", http.StatusInternalServerError)
		return
	}

	devices, err := process.catalog.ListDevices(request.Context(), entry.TenantID)
	if err != nil {
		http.Error(writer, "devices unavailable", http.StatusInternalServerError)
		return
	}
	payload, err := matrix.CommandPayload(overlay)
	if err != nil {
		http.Error(writer, "command could not be built", http.StatusInternalServerError)
		return
	}
	sent := 0
	for _, device := range devices {
		if _, err := process.queue.Enqueue(request.Context(), commands.Item{
			TenantID: entry.TenantID,
			DeviceID: device.ID,
			Kind:     commands.MatrixKind,
			// Derived from the device, the version and the payload, so
			// publishing an unchanged ledger collapses onto the same row
			// instead of queueing a second delivery of the same document.
			IdempotencyKey: commands.MatrixKey(device.ID, overlay.Version, payload),
			Payload:        payload,
			ExpiresAt:      time.Now().Add(commands.MatrixTTL),
		}); err == nil {
			sent++
		}
	}
	_ = process.audit.Append(request.Context(), entry.TenantID, audit.Event{
		Actor:  "console",
		Action: "ledger.published",
		Target: version,
	})
	writeJSON(writer, map[string]any{
		"version": version,
		"rules":   len(entries),
		"devices": sent,
	})
}
