// Package uptime records the minutes in which a device was reachable.
//
// The console could say whether a device is online now and nothing about
// whether it has been. "It is connected" and "it has been connected for the
// last three days" are different questions, and only the second one answers
// whether a stick is worth trusting with a job.
//
// # Why a bitmap in Redis and a row in PostgreSQL
//
// A device speaks about twice a minute -- the contract puts its heartbeat at
// thirty seconds -- so recording each sighting as a row would be a few hundred
// thousand rows a day per device to answer a question about ratios. Instead
// each hour is sixty bits, one per minute, set as the frames arrive; when the
// hour closes, the bits are counted once and the count becomes one row.
//
// 🔴 **Redis is the accumulator and never the record.** `internal/wakeup` says
// the same thing about its own use and for the same reason: a Redis that comes
// back empty must cost at most the hour in progress, never history. Everything
// already flushed is in PostgreSQL, and the flush is what makes a bucket real.
package uptime

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// MinutesPerHour is the width of one bucket, and the denominator of every
// ratio built from it.
const MinutesPerHour = 60

// Bucket is one device's presence in one closed hour.
type Bucket struct {
	TenantID string
	DeviceID string
	Hour     time.Time
	// Minutes in which at least one frame arrived, 0..60.
	Minutes int
}

// Broker is the slice of Redis this package needs.
//
// Narrow on purpose: the whole package is testable against a map, and nothing
// here can reach for a Redis command that the real deployment has not been
// shown to allow.
type Broker interface {
	SetBit(ctx context.Context, key string, offset int64, value int) error
	BitCount(ctx context.Context, key string) (int64, error)
	SAdd(ctx context.Context, key, member string) error
	SMembers(ctx context.Context, key string) ([]string, error)
	Expire(ctx context.Context, key string, ttl time.Duration) error
	Del(ctx context.Context, keys ...string) error
}

// Recorder marks minutes as they happen.
type Recorder struct {
	broker Broker
	// How long a bucket survives in Redis. Longer than an hour so a flush that
	// is late -- a restarted gateway, a slow tick -- still finds the bits, and
	// short enough that a gateway which stops flushing does not accumulate.
	ttl time.Duration
}

func NewRecorder(broker Broker) *Recorder {
	return &Recorder{broker: broker, ttl: 3 * time.Hour}
}

// Seen marks the minute of `at` for this device.
//
// Idempotent by construction: setting a bit that is already set is the same
// operation, so the twice-a-minute heartbeat costs nothing extra and a burst
// of frames in one minute counts once. That is the point -- the question is
// "was it there in this minute", not "how much did it say".
func (recorder *Recorder) Seen(ctx context.Context, tenantID, deviceID string, at time.Time) error {
	if recorder == nil || recorder.broker == nil {
		return nil
	}
	hour := at.UTC().Truncate(time.Hour)
	key := BitmapKey(deviceID, hour)
	if err := recorder.broker.SetBit(ctx, key, int64(at.UTC().Minute()), 1); err != nil {
		return fmt.Errorf("uptime setbit: %w", err)
	}
	if err := recorder.broker.Expire(ctx, key, recorder.ttl); err != nil {
		return fmt.Errorf("uptime expire: %w", err)
	}
	// The membership is what makes the hour sweepable without SCAN. It carries
	// the tenant because the row this becomes is written under tenant RLS, and
	// the bitmap key deliberately does not: one device belongs to one tenant,
	// and putting it in both places would create two answers to that.
	members := HourKey(hour)
	if err := recorder.broker.SAdd(ctx, members, tenantID+"|"+deviceID); err != nil {
		return fmt.Errorf("uptime sadd: %w", err)
	}
	return recorder.broker.Expire(ctx, members, recorder.ttl)
}

// Close reads and clears every bucket for one closed hour.
//
// The caller persists what comes back. Clearing here rather than after the
// write is deliberate in one direction only: a flush that fails loses that
// hour, which is a gap in a ratio, while a flush that runs twice would double
// count minutes into a total nobody could correct. Losing a bucket is the
// cheaper of the two and the one that shows up honestly as a gap.
func (recorder *Recorder) Close(ctx context.Context, hour time.Time) ([]Bucket, error) {
	if recorder == nil || recorder.broker == nil {
		return nil, nil
	}
	hour = hour.UTC().Truncate(time.Hour)
	members, err := recorder.broker.SMembers(ctx, HourKey(hour))
	if err != nil {
		return nil, fmt.Errorf("uptime smembers: %w", err)
	}
	buckets := make([]Bucket, 0, len(members))
	keys := make([]string, 0, len(members)+1)
	for _, member := range members {
		tenantID, deviceID, ok := strings.Cut(member, "|")
		if !ok || tenantID == "" || deviceID == "" {
			continue
		}
		key := BitmapKey(deviceID, hour)
		keys = append(keys, key)
		count, err := recorder.broker.BitCount(ctx, key)
		if err != nil {
			return nil, fmt.Errorf("uptime bitcount: %w", err)
		}
		if count <= 0 {
			continue
		}
		if count > MinutesPerHour {
			count = MinutesPerHour
		}
		buckets = append(buckets, Bucket{
			TenantID: tenantID,
			DeviceID: deviceID,
			Hour:     hour,
			Minutes:  int(count),
		})
	}
	keys = append(keys, HourKey(hour))
	if err := recorder.broker.Del(ctx, keys...); err != nil {
		return buckets, fmt.Errorf("uptime del: %w", err)
	}
	return buckets, nil
}

// BitmapKey is one device's minutes in one hour.
func BitmapKey(deviceID string, hour time.Time) string {
	return "uptime:m:" + deviceID + ":" + stamp(hour)
}

// HourKey is the set of devices with anything recorded in one hour.
func HourKey(hour time.Time) string {
	return "uptime:h:" + stamp(hour)
}

func stamp(hour time.Time) string {
	return hour.UTC().Format("2006010215")
}
