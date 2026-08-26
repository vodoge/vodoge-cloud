package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/audit"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/cards"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/commands"
	contract "github.com/vodoge/vodoge-cloud/packages/contract"
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
//
// # The payload is built from the contract type, not from the stored row
//
// contract.CardPolicy has four fields. cards.Policy has six: it is the database
// row, and it carries note and updated_at because the console's table shows
// them. Marshalling the row straight onto the wire put updated_at inside every
// policy object, and the edge parses CardPolicy with deny_unknown_fields.
//
// So every card policy push this deployment has ever made was unreadable by the
// device it was sent to. Confirmed against the deployed binaries on 2026-08-26
// by pushing both shapes at the bench: the stored shape produced
//
//	command: invalid envelope: unknown field `updated_at`,
//	expected one of `iccid`, `cellular_enabled`, `vertical`, `apn`
//
// on the device and no receipt at all, four re-sends and then expiry; the same
// set through contract.UpdateCardPolicyCommand was accepted in two seconds.
//
// Building through the generated type is what keeps the two in step: a field
// added to the row from now on cannot reach the wire by accident, and one added
// to the contract will not compile until it is filled in here.
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
	command := contract.UpdateCardPolicyCommand{
		Kind:          "UpdateCardPolicy",
		PolicyVersion: version,
		Policies:      make([]contract.CardPolicy, 0, len(policies)),
	}
	for _, policy := range policies {
		command.Policies = append(command.Policies, contract.CardPolicy{
			Iccid:           policy.ICCID,
			CellularEnabled: policy.CellularEnabled,
			Vertical:        policy.Vertical,
			Apn:             policy.APN,
		})
	}
	// Marshalled here rather than through mustJSON, which takes a map: the whole
	// point of this change is that the wire shape is the generated struct.
	payload, err := json.Marshal(command)
	if err != nil {
		return
	}
	for _, device := range devices {
		_, _ = process.queue.Enqueue(request.Context(), commands.Item{
			TenantID: tenantID,
			DeviceID: device.ID,
			Kind:     commands.CardPolicyKind,
			// Derived from the device, the version and the payload, and from
			// nothing else. It used to carry time.Now().UnixNano(), which made
			// every push a new row that no repeat could ever collapse onto --
			// see commands.CardPolicyKey. The same derivation is what lets a
			// redelivery on resume name itself as another attempt at this
			// intent instead of a second intention.
			IdempotencyKey: commands.CardPolicyKey(device.ID, version, payload),
			Payload:        payload,
			// The window is short on purpose and the redelivery in
			// internal/commands carries the durability instead: a still-queued
			// command is re-sent off any inbound traffic, so a longer window is
			// mostly a longer re-send loop against a device that is not
			// answering.
			ExpiresAt: time.Now().Add(commands.CardPolicyTTL),
		})
	}
}
