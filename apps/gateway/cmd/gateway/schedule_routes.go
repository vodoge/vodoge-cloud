package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
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

func (process *process) updateSchedule(writer http.ResponseWriter, request *http.Request) {
	entry, ok := process.tenantFromRequest(writer, request)
	if !ok {
		return
	}
	if process.schedules == nil {
		http.Error(writer, "schedules are unavailable", http.StatusServiceUnavailable)
		return
	}
	var body struct {
		Enabled *bool `json:"enabled"`
	}
	if err := json.NewDecoder(io.LimitReader(request.Body, 4<<10)).Decode(&body); err != nil {
		http.Error(writer, "invalid schedule", http.StatusBadRequest)
		return
	}
	// Only the switch is editable. Changing an interval or a payload in place
	// would renumber or redefine occurrences that may already be in flight,
	// and app.enqueue_command answers a key bound to a different payload by
	// refusing -- so an edit would show up as a failed run rather than as the
	// change the operator thought they made. Delete and recreate is honest
	// about the fact that it is a different schedule.
	if body.Enabled == nil {
		http.Error(writer, "enabled is required", http.StatusBadRequest)
		return
	}
	updated, err := process.schedules.SetEnabled(
		request.Context(), entry.TenantID, request.PathValue("id"), *body.Enabled)
	if errors.Is(err, sql.ErrNoRows) {
		http.Error(writer, "schedule not found", http.StatusNotFound)
		return
	}
	if err != nil {
		slog.Warn("schedule could not be updated",
			"tenant_id", entry.TenantID, "error", err)
		http.Error(writer, "schedule could not be updated", http.StatusInternalServerError)
		return
	}
	_ = process.audit.Append(request.Context(), entry.TenantID, audit.Event{
		Actor:  "console",
		Action: "update_schedule",
		Target: updated.Name,
		Detail: json.RawMessage(`{"enabled":` + boolText(updated.Enabled) + `}`),
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

func boolText(value bool) string {
	if value {
		return "true"
	}
	return "false"
}
