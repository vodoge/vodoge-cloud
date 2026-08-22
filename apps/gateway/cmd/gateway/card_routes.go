package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/audit"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/cards"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/commands"
)

func (process *process) registerCardRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/cards/policies", process.listCardPolicies)
	mux.HandleFunc("GET /v1/cards/{iccid}/policy", process.readCardPolicy)
	mux.HandleFunc("PUT /v1/cards/{iccid}/policy", process.writeCardPolicy)
	mux.HandleFunc("DELETE /v1/cards/{iccid}/policy", process.deleteCardPolicy)
}

func (process *process) listCardPolicies(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	list, err := process.cards.List(request.Context(), entry.TenantID)
	if err != nil {
		http.Error(writer, "policies unavailable", http.StatusInternalServerError)
		return
	}
	version, _ := process.cards.Version(request.Context(), entry.TenantID)
	writeJSON(writer, map[string]any{"policies": list, "version": version})
}

func (process *process) readCardPolicy(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	policy, found, err := process.cards.Get(request.Context(), entry.TenantID,
		request.PathValue("iccid"))
	if err != nil {
		http.Error(writer, "policies unavailable", http.StatusInternalServerError)
		return
	}
	if !found {
		http.Error(writer, "no policy for that card", http.StatusNotFound)
		return
	}
	writeJSON(writer, policy)
}

func (process *process) writeCardPolicy(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	var policy cards.Policy
	if err := json.NewDecoder(io.LimitReader(request.Body, 8<<10)).Decode(&policy); err != nil {
		http.Error(writer, "invalid policy", http.StatusBadRequest)
		return
	}
	// The path wins over the body: two sources for the same identifier is how
	// a policy ends up saved against a different card than the one being
	// edited.
	policy.ICCID = request.PathValue("iccid")
	if err := cards.Validate(&policy); err != nil {
		var invalid cards.ErrInvalid
		if errors.As(err, &invalid) {
			http.Error(writer, invalid.Reason, http.StatusBadRequest)
			return
		}
		http.Error(writer, "invalid policy", http.StatusBadRequest)
		return
	}
	if err := process.cards.Save(request.Context(), entry.TenantID, policy); err != nil {
		http.Error(writer, "policy could not be saved", http.StatusInternalServerError)
		return
	}
	_ = process.audit.Append(request.Context(), entry.TenantID, audit.Event{
		Actor:  "console",
		Action: "cards.policy_saved",
		Target: policy.ICCID,
	})
	process.pushCardPolicies(request, entry.TenantID)
	// Re-read rather than echoing what was sent: the stored row carries the
	// timestamp, and returning the request's zero value would have the
	// response claim the policy was last changed at the epoch.
	if stored, found, err := process.cards.Get(request.Context(), entry.TenantID, policy.ICCID); err == nil && found {
		policy = stored
	}
	writeJSON(writer, policy)
}

func (process *process) deleteCardPolicy(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	iccid := request.PathValue("iccid")
	if err := process.cards.Delete(request.Context(), entry.TenantID, iccid); err != nil {
		http.Error(writer, "policy could not be removed", http.StatusInternalServerError)
		return
	}
	_ = process.audit.Append(request.Context(), entry.TenantID, audit.Event{
		Actor:  "console",
		Action: "cards.policy_removed",
		Target: iccid,
	})
	process.pushCardPolicies(request, entry.TenantID)
	writer.WriteHeader(http.StatusNoContent)
}

// pushCardPolicies hands every device the tenant's full policy set.
//
// Every device, because a policy is keyed by ICCID and any device might be
// holding that card — including one that has not reported it yet. The whole
// set rather than the changed row, because the edge applies it by replacing
// what it holds; a device that missed one change would otherwise be wrong
// about that card forever.
//
// The contract requires at least one policy, so an emptied set sends nothing.
// A device keeps its last set until told otherwise, which is the safer of the
// two wrong answers: the alternative interpretation of "no policies" is "deny
// everything", and applying that to a fleet by deleting a row would be a
// spectacular way to take every card offline.
func (process *process) pushCardPolicies(request *http.Request, tenantID string) {
	policies, err := process.cards.List(request.Context(), tenantID)
	if err != nil || len(policies) == 0 {
		return
	}
	version, err := process.cards.Version(request.Context(), tenantID)
	if err != nil {
		return
	}
	devices, err := process.catalog.ListDevices(request.Context(), tenantID)
	if err != nil {
		return
	}
	payload := mustJSON(map[string]any{
		"kind":           "UpdateCardPolicy",
		"policy_version": version,
		"policies":       policies,
	})
	for _, device := range devices {
		_, _ = process.queue.Enqueue(request.Context(), commands.Item{
			TenantID: tenantID,
			DeviceID: device.ID,
			Kind:     "update_card_policy",
			IdempotencyKey: "update_card_policy:" + device.ID + ":" + version + ":" +
				strconv.FormatInt(time.Now().UnixNano(), 10),
			Payload:   payload,
			ExpiresAt: time.Now().Add(30 * time.Minute),
		})
	}
}
