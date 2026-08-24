package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/audit"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/commands"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/schedule"
)

// registerScheduleRoutes exposes the recurring-task list.
func (process *process) registerScheduleRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/schedules", process.listSchedules)
	mux.HandleFunc("POST /v1/schedules", process.createSchedule)
	mux.HandleFunc("PATCH /v1/schedules/{id}", process.updateSchedule)
	mux.HandleFunc("DELETE /v1/schedules/{id}", process.deleteSchedule)
}

// scheduleView is the wire shape. Times go out as milliseconds, matching every
// other console payload, so the page needs no second date convention.
type scheduleView struct {
	ID              string          `json:"id"`
	Name            string          `json:"name"`
	Enabled         bool            `json:"enabled"`
	Action          string          `json:"action"`
	CommandKind     string          `json:"command_kind,omitempty"`
	Selector        json.RawMessage `json:"selector"`
	Request         json.RawMessage `json:"request"`
	IntervalSeconds int             `json:"interval_seconds"`
	AnchorAt        int64           `json:"anchor_at"`
	LastOccurrence  int64           `json:"last_occurrence"`
	NextDueAt       int64           `json:"next_due_at"`
	LastRunAt       *int64          `json:"last_run_at,omitempty"`
	LastStatus      string          `json:"last_status,omitempty"`
	LastDetail      json.RawMessage `json:"last_detail,omitempty"`
	LastCommandID   string          `json:"last_command_id,omitempty"`
}

func toScheduleView(task schedule.Task) scheduleView {
	selector, err := json.Marshal(task.Selector)
	if err != nil {
		selector = []byte(`{}`)
	}
	request := task.Request
	if len(request) == 0 {
		request = json.RawMessage(`{}`)
	}
	detail := task.LastDetail
	if len(detail) == 0 {
		detail = json.RawMessage(`{}`)
	}
	view := scheduleView{
		ID:              task.ID,
		Name:            task.Name,
		Enabled:         task.Enabled,
		Action:          task.Action,
		CommandKind:     task.CommandKind,
		Selector:        selector,
		Request:         request,
		IntervalSeconds: task.IntervalSeconds,
		AnchorAt:        task.AnchorAt.UnixMilli(),
		LastOccurrence:  task.LastOccurrence,
		NextDueAt:       task.NextDueAt().UnixMilli(),
		LastStatus:      task.LastStatus,
		LastDetail:      detail,
		LastCommandID:   task.LastCommandID,
	}
	if task.LastRunAt != nil {
		ms := task.LastRunAt.UnixMilli()
		view.LastRunAt = &ms
	}
	return view
}

func (process *process) listSchedules(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	if process.schedules == nil {
		http.Error(writer, "schedules are unavailable", http.StatusServiceUnavailable)
		return
	}
	tasks, err := process.schedules.List(request.Context(), entry.TenantID)
	if err != nil {
		slog.Warn("schedules could not be listed",
			"tenant_id", entry.TenantID, "error", err)
		http.Error(writer, "schedules unavailable", http.StatusInternalServerError)
		return
	}
	views := make([]scheduleView, 0, len(tasks))
	for _, task := range tasks {
		views = append(views, toScheduleView(task))
	}
	writeJSON(writer, map[string]any{"schedules": views})
}

// scheduleBody is what a caller posts to create a schedule.
//
// anchor_at is accepted so a task can be lined up with wall-clock time -- "on
// the hour" is an anchor at the top of some hour, not a cadence -- and it is
// the only way to express that, because the interval alone says nothing about
// phase.
type scheduleBody struct {
	Name            string            `json:"name"`
	Enabled         *bool             `json:"enabled"`
	Action          string            `json:"action"`
	CommandKind     string            `json:"command_kind"`
	Selector        schedule.Selector `json:"selector"`
	Request         json.RawMessage   `json:"request"`
	IntervalSeconds int               `json:"interval_seconds"`
	AnchorAt        *int64            `json:"anchor_at_ms"`
}

func (process *process) createSchedule(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	if process.schedules == nil {
		http.Error(writer, "schedules are unavailable", http.StatusServiceUnavailable)
		return
	}
	var body scheduleBody
	if err := json.NewDecoder(io.LimitReader(request.Body, 64<<10)).Decode(&body); err != nil {
		http.Error(writer, "invalid schedule", http.StatusBadRequest)
		return
	}
	if body.Action == "" {
		body.Action = schedule.ActionCommand
	}
	enabled := true
	if body.Enabled != nil {
		enabled = *body.Enabled
	}
	task := schedule.Task{
		Name:            body.Name,
		Enabled:         enabled,
		Action:          body.Action,
		CommandKind:     body.CommandKind,
		Selector:        body.Selector,
		Request:         body.Request,
		IntervalSeconds: body.IntervalSeconds,
	}
	if body.AnchorAt != nil {
		task.AnchorAt = time.UnixMilli(*body.AnchorAt)
	}
	// Validated here rather than at the first run, for the reason
	// commands.BuildPayload already gives: a task that cannot succeed should be
	// refused while the caller is still there. The alternative is a schedule
	// that looks configured and fails quietly every hour.
	if err := schedule.Validate(&task); err != nil {
		var invalid commands.ErrInvalid
		if errors.As(err, &invalid) {
			http.Error(writer, invalid.Reason, http.StatusBadRequest)
			return
		}
		http.Error(writer, "invalid schedule", http.StatusBadRequest)
		return
	}
	created, err := process.schedules.Create(request.Context(), entry.TenantID, task)
	if err != nil {
		slog.Warn("schedule could not be created",
			"tenant_id", entry.TenantID, "name", task.Name, "error", err)
		http.Error(writer, "schedule could not be created", http.StatusInternalServerError)
		return
	}
	detail, _ := json.Marshal(map[string]any{
		"action":           created.Action,
		"command_kind":     created.CommandKind,
		"interval_seconds": created.IntervalSeconds,
	})
	_ = process.audit.Append(request.Context(), entry.TenantID, audit.Event{
		Actor:  "console",
		Action: "create_schedule",
		Target: created.Name,
		Detail: detail,
	})
	// Content-Type before WriteHeader: after it the header map is already on
	// the wire and the write is silently ignored.
	writer.Header().Set("Content-Type", "application/json; charset=utf-8")
	writer.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(writer).Encode(toScheduleView(created))
}

// schedulePatchFields is everything PATCH /v1/schedules/{id} will apply.
//
// enabled is a switch: it renumbers nothing. selector is re-evaluated on every
// run by design -- 0038 keeps it as "how the target is found ... evaluated at
// fire time rather than stored" -- so repointing a task at another SIM changes
// what the next run resolves and leaves the occurrence grid untouched.
//
// Everything else is refused by name. Changing an interval, an anchor, a
// payload or a kind in place would renumber or redefine occurrences that may
// already be in flight, and app.enqueue_command answers a key bound to a
// different payload by refusing -- so the edit would surface as a failed run
// rather than as the change the operator thought they made. Delete and
// recreate is honest about the fact that it is a different schedule.
//
// That reasoning was already here. What was missing is that the fields it
// argues against were dropped *silently*: the handler decoded into a struct
// with one field, encoding/json threw the rest away, and the response was 200
// with the unchanged row. An operator who PATCHed a selector was told the
// change had landed. A refusal an automation can see beats a success it cannot
// check.
var schedulePatchFields = map[string]bool{"enabled": true, "selector": true}

func (process *process) updateSchedule(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	if process.schedules == nil {
		http.Error(writer, "schedules are unavailable", http.StatusServiceUnavailable)
		return
	}
	// Decoded key by key rather than straight into a struct. Decoder's
	// DisallowUnknownFields would refuse too, but only through an error string
	// this handler would then have to parse to say which field it was -- and
	// naming the field is the entire point of the refusal.
	var fields map[string]json.RawMessage
	if err := json.NewDecoder(io.LimitReader(request.Body, 4<<10)).Decode(&fields); err != nil {
		http.Error(writer, "invalid schedule", http.StatusBadRequest)
		return
	}
	refused := []string{}
	for name := range fields {
		if !schedulePatchFields[name] {
			refused = append(refused, strconv.Quote(name))
		}
	}
	if len(refused) > 0 {
		// Sorted because map iteration is randomised, and a refusal whose
		// wording changes between two identical requests is one an operator
		// cannot match against anything.
		sort.Strings(refused)
		http.Error(writer, strings.Join(refused, ", ")+
			" cannot be changed in place; delete and recreate the schedule",
			http.StatusBadRequest)
		return
	}
	var edit schedule.Edit
	if raw, present := fields["enabled"]; present {
		// Through a pointer: JSON null unmarshals into a bool as a no-op, so a
		// {"enabled":null} decoded directly would read as false and turn the
		// schedule off.
		var enabled *bool
		if err := json.Unmarshal(raw, &enabled); err != nil || enabled == nil {
			http.Error(writer, "enabled must be true or false", http.StatusBadRequest)
			return
		}
		edit.Enabled = enabled
	}
	if raw, present := fields["selector"]; present {
		var selector *schedule.Selector
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&selector); err != nil {
			http.Error(writer, "selector is not a selector: "+err.Error(),
				http.StatusBadRequest)
			return
		}
		if selector == nil {
			http.Error(writer, "selector must be an object", http.StatusBadRequest)
			return
		}
		edit.Selector = selector
	}
	if edit.Enabled == nil && edit.Selector == nil {
		http.Error(writer, "enabled or selector is required", http.StatusBadRequest)
		return
	}
	// Asserted, not assumed. A store that cannot apply an edit has to say so;
	// falling through to a 200 is the bug this route is being fixed for.
	editor, ok := process.schedules.(schedule.Editor)
	if !ok {
		slog.Warn("schedule store cannot apply edits", "tenant_id", entry.TenantID)
		http.Error(writer, "schedule could not be updated", http.StatusInternalServerError)
		return
	}
	updated, err := editor.Update(
		request.Context(), entry.TenantID, request.PathValue("id"), edit)
	if errors.Is(err, sql.ErrNoRows) {
		http.Error(writer, "schedule not found", http.StatusNotFound)
		return
	}
	// A selector that could only fail on every run is refused with the reason,
	// the same way createSchedule refuses one.
	var invalid commands.ErrInvalid
	if errors.As(err, &invalid) {
		http.Error(writer, invalid.Reason, http.StatusBadRequest)
		return
	}
	if err != nil {
		slog.Warn("schedule could not be updated",
			"tenant_id", entry.TenantID, "error", err)
		http.Error(writer, "schedule could not be updated", http.StatusInternalServerError)
		return
	}
	// The audit line carries the selector whenever it moved. The incident that
	// produced this fix was an operator believing a schedule had been
	// retargeted; the log has to be able to answer that question afterwards.
	event := map[string]any{"enabled": updated.Enabled}
	if edit.Selector != nil {
		event["selector"] = updated.Selector
	}
	detail, _ := json.Marshal(event)
	_ = process.audit.Append(request.Context(), entry.TenantID, audit.Event{
		Actor:  "console",
		Action: "update_schedule",
		Target: updated.Name,
		Detail: detail,
	})
	writeJSON(writer, toScheduleView(updated))
}
func (process *process) deleteSchedule(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	if process.schedules == nil {
		http.Error(writer, "schedules are unavailable", http.StatusServiceUnavailable)
		return
	}
	id := request.PathValue("id")
	removed, err := process.schedules.Delete(request.Context(), entry.TenantID, id)
	if err != nil {
		slog.Warn("schedule could not be deleted",
			"tenant_id", entry.TenantID, "error", err)
		http.Error(writer, "schedule could not be deleted", http.StatusInternalServerError)
		return
	}
	if !removed {
		http.Error(writer, "schedule not found", http.StatusNotFound)
		return
	}
	_ = process.audit.Append(request.Context(), entry.TenantID, audit.Event{
		Actor:  "console",
		Action: "delete_schedule",
		Target: id,
	})
	writer.WriteHeader(http.StatusNoContent)
}
