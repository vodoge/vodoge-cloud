package main

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/audit"
)

func (process *process) registerDeviceRoutes(mux *http.ServeMux) {
	mux.HandleFunc("PATCH /v1/devices/{id}", process.renameDevice)
	mux.HandleFunc("DELETE /v1/devices/{id}", process.deleteDevice)
}

// renameDevice changes the label a device is known by.
//
// Only the name is editable. Everything else — IMEI, region, what it is
// running — is reported by the device, and a console that could edit those
// would be inviting someone to write down what they wish were true.
func (process *process) renameDevice(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := json.NewDecoder(io.LimitReader(request.Body, 4<<10)).Decode(&body); err != nil {
		http.Error(writer, "invalid request", http.StatusBadRequest)
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		http.Error(writer, "name must not be empty", http.StatusBadRequest)
		return
	}
	if len([]rune(name)) > 128 {
		http.Error(writer, "name must be 128 characters or fewer", http.StatusBadRequest)
		return
	}
	id := request.PathValue("id")
	if err := process.catalog.RenameDevice(request.Context(), entry.TenantID, id, name); err != nil {
		http.Error(writer, "device could not be renamed", http.StatusInternalServerError)
		return
	}
	_ = process.audit.Append(request.Context(), entry.TenantID, audit.Event{
		Actor:  "console",
		Action: "devices.renamed",
		Target: id,
		Detail: mustJSON(map[string]any{"name": name}),
	})
	writeJSON(writer, map[string]any{"id": id, "name": name})
}

// deleteDevice removes a device and everything that hangs off it.
//
// This destroys the device's whole journal, which is the record of everything
// it ever reported. Audited before the delete rather than after: the audit row
// references the tenant, not the device, so it survives — and it is the only
// thing that will.
func (process *process) deleteDevice(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	id := request.PathValue("id")
	_ = process.audit.Append(request.Context(), entry.TenantID, audit.Event{
		Actor:  "console",
		Action: "devices.deleted",
		Target: id,
	})
	existed, err := process.catalog.DeleteDevice(request.Context(), entry.TenantID, id)
	if err != nil {
		http.Error(writer, "device could not be removed", http.StatusInternalServerError)
		return
	}
	if !existed {
		http.Error(writer, "no such device", http.StatusNotFound)
		return
	}
	writer.WriteHeader(http.StatusNoContent)
}
