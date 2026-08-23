package observe

// Notification delivery metrics.
//
// Separate from the HTTP and uplink series in http.go because they answer a
// different question, and one nobody could answer before: how many
// notifications did we lose, and how hard did we try. Delivery ran on a single
// goroutine behind a 256-deep queue and logged a warning when it gave up, so
// "did anything get dropped last night" meant grepping container logs that
// rotate. A counter is the difference between suspecting and knowing.
//
// Labels are deliberately coarse. Channel names and drop reasons are both
// fixed, small sets; a tenant label would grow the series count with the
// customer list for a number that is only ever read in aggregate.
const (
	// NotificationsTotal counts finished deliveries, by channel and result
	// (delivered, failed, not_configured). A delivery is "failed" only after
	// the whole retry window has been spent.
	NotificationsTotal = "vodoge_notifications_total"
	// NotificationRetries counts re-attempts, by channel. Rising while
	// NotificationsTotal{result="delivered"} also rises is a flaky receiver;
	// rising alone is a dead one.
	NotificationRetries = "vodoge_notification_retries_total"
	// NotificationsDropped counts notifications nobody will ever receive, by
	// reason: queue_full (intake backlog), lane_full (one channel's backlog),
	// lane_limit, settings_unavailable. Dropping under pressure is deliberate
	// — notifications must not become back-pressure on the device uplink —
	// but it should be visible rather than merely intended.
	NotificationsDropped = "vodoge_notifications_dropped_total"
)

// DeclareNotifications registers the notification metrics.
//
// Called alongside Declare rather than folded into it so that the notification
// series arrive with the package that produces them.
func DeclareNotifications(registry *Registry) {
	registry.Count(NotificationsTotal, "Notification deliveries, by channel and result.")
	registry.Count(NotificationRetries, "Notification delivery retries, by channel.")
	registry.Count(NotificationsDropped, "Notifications dropped undelivered, by reason.")
}
