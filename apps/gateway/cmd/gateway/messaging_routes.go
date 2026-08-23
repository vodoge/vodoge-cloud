package main

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/audit"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/messaging"
)

func (process *process) registerMessagingRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/messages/threads", process.listThreads)
	mux.HandleFunc("GET /v1/messages/thread", process.readThread)
	mux.HandleFunc("DELETE /v1/messages/thread", process.deleteThread)
	mux.HandleFunc("POST /v1/messages/thread/read", process.markThreadRead)
	mux.HandleFunc("GET /v1/messages/contacts", process.listContacts)
	mux.HandleFunc("PUT /v1/messages/contact", process.saveContact)
	mux.HandleFunc("DELETE /v1/messages/contact", process.deleteContact)
	mux.HandleFunc("DELETE /v1/messages/{id}", process.deleteMessage)
}

// markThreadRead clears the unread badge for one conversation.
//
// A write, so it is a POST rather than something the thread GET does on the
// way past: a page that marked messages read by being rendered would clear
// them on a link preview, a prefetch, or the second render Next.js does of
// every server component.
func (process *process) markThreadRead(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	peer, ok := peerFromBody(writer, request)
	if !ok {
		return
	}
	marked, err := process.inbox.MarkThreadRead(request.Context(), entry.TenantID, peer)
	if err != nil {
		http.Error(writer, "messages unavailable", http.StatusInternalServerError)
		return
	}
	writeJSON(writer, map[string]any{"marked": marked})
}

func (process *process) listContacts(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	contacts, err := process.inbox.Contacts(request.Context(), entry.TenantID)
	if err != nil {
		http.Error(writer, "messages unavailable", http.StatusInternalServerError)
		return
	}
	writeJSON(writer, map[string]any{"contacts": contacts})
}

// saveContact names a number. PUT because it is an upsert on the number: the
// caller does not know or care whether this contact already existed.
func (process *process) saveContact(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	var body struct {
		Peer string `json:"peer"`
		Name string `json:"name"`
		Note string `json:"note"`
	}
	if err := json.NewDecoder(io.LimitReader(request.Body, 4<<10)).Decode(&body); err != nil {
		http.Error(writer, "invalid request", http.StatusBadRequest)
		return
	}
	body.Peer = strings.TrimSpace(body.Peer)
	body.Name = strings.TrimSpace(body.Name)
	body.Note = strings.TrimSpace(body.Note)
	// Checked here as well as by the table constraint. A blank name reaching
	// the database is a 500 the operator cannot act on, where this is the
	// sentence that says what to do.
	if body.Peer == "" || body.Name == "" {
		http.Error(writer, "peer and name are required", http.StatusBadRequest)
		return
	}
	if len(body.Peer) > 64 || len(body.Name) > 128 || len(body.Note) > 512 {
		http.Error(writer, "contact is too long", http.StatusBadRequest)
		return
	}
	contact := messaging.Contact{Peer: body.Peer, Name: body.Name, Note: body.Note}
	if err := process.inbox.SaveContact(request.Context(), entry.TenantID, contact); err != nil {
		http.Error(writer, "messages unavailable", http.StatusInternalServerError)
		return
	}
	_ = process.audit.Append(request.Context(), entry.TenantID, audit.Event{
		Actor:  "console",
		Action: "messages.contact_saved",
		Target: body.Peer,
	})
	writeJSON(writer, map[string]any{"contact": contact})
}

func (process *process) deleteContact(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	peer, ok := peerFromBody(writer, request)
	if !ok {
		return
	}
	if err := process.inbox.DeleteContact(request.Context(), entry.TenantID, peer); err != nil {
		http.Error(writer, "messages unavailable", http.StatusInternalServerError)
		return
	}
	_ = process.audit.Append(request.Context(), entry.TenantID, audit.Event{
		Actor:  "console",
		Action: "messages.contact_deleted",
		Target: peer,
	})
	writer.WriteHeader(http.StatusNoContent)
}

// peerFromBody reads the one field these routes share.
//
// In the body rather than the path, for the same reason deleteThread does it:
// a phone number in a URL ends up in every access log and proxy cache between
// here and the browser.
func peerFromBody(writer http.ResponseWriter, request *http.Request) (string, bool) {
	var body struct {
		Peer string `json:"peer"`
	}
	if err := json.NewDecoder(io.LimitReader(request.Body, 4<<10)).Decode(&body); err != nil {
		http.Error(writer, "invalid request", http.StatusBadRequest)
		return "", false
	}
	if body.Peer == "" {
		http.Error(writer, "peer is required", http.StatusBadRequest)
		return "", false
	}
	return body.Peer, true
}

// listThreads is the inbox: one row per conversation, most recent first.
func (process *process) listThreads(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	threads, err := process.inbox.Threads(request.Context(), entry.TenantID)
	if err != nil {
		http.Error(writer, "messages unavailable", http.StatusInternalServerError)
		return
	}
	writeJSON(writer, map[string]any{"threads": threads})
}

func (process *process) readThread(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	peer := request.URL.Query().Get("peer")
	if peer == "" {
		http.Error(writer, "peer is required", http.StatusBadRequest)
		return
	}
	limit := 200
	if raw := request.URL.Query().Get("limit"); raw != "" {
		if parsed, err := strconv.Atoi(raw); err == nil {
			limit = parsed
		}
	}
	messages, err := process.inbox.Thread(request.Context(), entry.TenantID, peer, limit)
	if err != nil {
		http.Error(writer, "messages unavailable", http.StatusInternalServerError)
		return
	}
	writeJSON(writer, map[string]any{"peer": peer, "messages": messages})
}

// deleteThread removes a whole conversation.
//
// The peer travels in the body rather than the path: a phone number in a URL
// ends up in every access log and proxy cache between here and the browser,
// and a conversation is exactly the sort of thing that should not.
func (process *process) deleteThread(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	var body struct {
		Peer string `json:"peer"`
	}
	if err := json.NewDecoder(io.LimitReader(request.Body, 4<<10)).Decode(&body); err != nil {
		http.Error(writer, "invalid request", http.StatusBadRequest)
		return
	}
	if body.Peer == "" {
		http.Error(writer, "peer is required", http.StatusBadRequest)
		return
	}
	removed, err := process.inbox.DeleteThread(request.Context(), entry.TenantID, body.Peer)
	if err != nil {
		http.Error(writer, "messages unavailable", http.StatusInternalServerError)
		return
	}
	// Deleting a conversation is not recoverable, so it is audited with the
	// count — enough to notice an accident, without copying the messages
	// themselves into a log that is read far more widely.
	_ = process.audit.Append(request.Context(), entry.TenantID, audit.Event{
		Actor:  "console",
		Action: "messages.thread_deleted",
		Target: body.Peer,
		Detail: mustJSON(map[string]any{"removed": removed}),
	})
	writeJSON(writer, map[string]any{"removed": removed})
}

func (process *process) deleteMessage(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	id := request.PathValue("id")
	if err := process.inbox.DeleteMessage(request.Context(), entry.TenantID, id); err != nil {
		http.Error(writer, "messages unavailable", http.StatusInternalServerError)
		return
	}
	_ = process.audit.Append(request.Context(), entry.TenantID, audit.Event{
		Actor:  "console",
		Action: "messages.deleted",
		Target: id,
	})
	writer.WriteHeader(http.StatusNoContent)
}
