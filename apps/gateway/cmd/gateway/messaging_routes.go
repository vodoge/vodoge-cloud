package main

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/audit"
)

func (process *process) registerMessagingRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/messages/threads", process.listThreads)
	mux.HandleFunc("GET /v1/messages/thread", process.readThread)
	mux.HandleFunc("DELETE /v1/messages/thread", process.deleteThread)
	mux.HandleFunc("DELETE /v1/messages/{id}", process.deleteMessage)
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
