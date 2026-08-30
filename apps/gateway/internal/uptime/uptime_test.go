package uptime

import (
	"context"
	"testing"
	"time"
)

// A map standing in for Redis. Bitmaps are held as sets of offsets because
// that is what the two operations this package uses actually mean.
type fakeBroker struct {
	bits    map[string]map[int64]bool
	sets    map[string]map[string]bool
	expires map[string]time.Duration
	deleted []string
}

func newFake() *fakeBroker {
	return &fakeBroker{
		bits:    map[string]map[int64]bool{},
		sets:    map[string]map[string]bool{},
		expires: map[string]time.Duration{},
	}
}

func (f *fakeBroker) SetBit(_ context.Context, key string, offset int64, value int) error {
	if f.bits[key] == nil {
		f.bits[key] = map[int64]bool{}
	}
	f.bits[key][offset] = value == 1
	return nil
}

func (f *fakeBroker) BitCount(_ context.Context, key string) (int64, error) {
	var count int64
	for _, set := range f.bits[key] {
		if set {
			count++
		}
	}
	return count, nil
}

func (f *fakeBroker) SAdd(_ context.Context, key, member string) error {
	if f.sets[key] == nil {
		f.sets[key] = map[string]bool{}
	}
	f.sets[key][member] = true
	return nil
}

func (f *fakeBroker) SMembers(_ context.Context, key string) ([]string, error) {
	out := []string{}
	for member := range f.sets[key] {
		out = append(out, member)
	}
	return out, nil
}

func (f *fakeBroker) Expire(_ context.Context, key string, ttl time.Duration) error {
	f.expires[key] = ttl
	return nil
}

func (f *fakeBroker) Del(_ context.Context, keys ...string) error {
	f.deleted = append(f.deleted, keys...)
	for _, key := range keys {
		delete(f.bits, key)
		delete(f.sets, key)
	}
	return nil
}

func at(hour, minute int) time.Time {
	return time.Date(2026, 8, 30, hour, minute, 0, 0, time.UTC)
}

// 🔴 The property the whole design rests on: a device speaking twice a minute
// must cost one bit, not two. If repeated sightings accumulated, an hour would
// report more minutes than it has and every ratio built on it would be wrong.
func TestRepeatedSightingsInOneMinuteCountOnce(t *testing.T) {
	broker := newFake()
	recorder := NewRecorder(broker)
	ctx := context.Background()
	for range 10 {
		if err := recorder.Seen(ctx, "t-a", "d-1", at(9, 30)); err != nil {
			t.Fatal(err)
		}
	}
	buckets, err := recorder.Close(ctx, at(9, 0))
	if err != nil {
		t.Fatal(err)
	}
	if len(buckets) != 1 || buckets[0].Minutes != 1 {
		t.Fatalf("buckets = %+v, want one minute", buckets)
	}
}

func TestEachMinuteSeenIsCountedOnce(t *testing.T) {
	broker := newFake()
	recorder := NewRecorder(broker)
	ctx := context.Background()
	for minute := range 17 {
		if err := recorder.Seen(ctx, "t-a", "d-1", at(9, minute)); err != nil {
			t.Fatal(err)
		}
	}
	buckets, err := recorder.Close(ctx, at(9, 0))
	if err != nil {
		t.Fatal(err)
	}
	if len(buckets) != 1 {
		t.Fatalf("buckets = %+v", buckets)
	}
	if buckets[0].Minutes != 17 {
		t.Fatalf("minutes = %d, want 17", buckets[0].Minutes)
	}
	if buckets[0].TenantID != "t-a" || buckets[0].DeviceID != "d-1" {
		t.Fatalf("bucket lost its identity: %+v", buckets[0])
	}
	if !buckets[0].Hour.Equal(at(9, 0)) {
		t.Fatalf("hour = %v", buckets[0].Hour)
	}
}

// Minutes belong to the hour they happened in, not the hour a flush ran in.
func TestMinutesLandInTheirOwnHour(t *testing.T) {
	broker := newFake()
	recorder := NewRecorder(broker)
	ctx := context.Background()
	for _, moment := range []time.Time{at(9, 5), at(9, 6), at(10, 5)} {
		if err := recorder.Seen(ctx, "t-a", "d-1", moment); err != nil {
			t.Fatal(err)
		}
	}
	nine, err := recorder.Close(ctx, at(9, 0))
	if err != nil {
		t.Fatal(err)
	}
	if len(nine) != 1 || nine[0].Minutes != 2 {
		t.Fatalf("nine = %+v, want two minutes", nine)
	}
	ten, err := recorder.Close(ctx, at(10, 0))
	if err != nil {
		t.Fatal(err)
	}
	if len(ten) != 1 || ten[0].Minutes != 1 {
		t.Fatalf("ten = %+v, want one minute", ten)
	}
}

// 🔴 Closing an hour clears it. A second flush of the same hour must produce
// nothing, because a bucket counted twice inflates a total nobody can correct
// afterwards -- whereas a bucket lost shows up honestly as a gap.
func TestAClosedHourDoesNotComeBack(t *testing.T) {
	broker := newFake()
	recorder := NewRecorder(broker)
	ctx := context.Background()
	if err := recorder.Seen(ctx, "t-a", "d-1", at(9, 30)); err != nil {
		t.Fatal(err)
	}
	if _, err := recorder.Close(ctx, at(9, 0)); err != nil {
		t.Fatal(err)
	}
	again, err := recorder.Close(ctx, at(9, 0))
	if err != nil {
		t.Fatal(err)
	}
	if len(again) != 0 {
		t.Fatalf("a closed hour was counted a second time: %+v", again)
	}
}

// An hour nothing spoke in is not an error and not a row: a device that was
// off has no minutes, and inventing a zero row for every device every hour
// would fill the table with the absence of information.
func TestAnEmptyHourProducesNothing(t *testing.T) {
	recorder := NewRecorder(newFake())
	buckets, err := recorder.Close(context.Background(), at(3, 0))
	if err != nil {
		t.Fatal(err)
	}
	if len(buckets) != 0 {
		t.Fatalf("buckets = %+v", buckets)
	}
}

// Two devices in one hour are two buckets, and neither takes the other's
// minutes: the bitmap is keyed on the device and only the set is shared.
func TestDevicesDoNotShareMinutes(t *testing.T) {
	broker := newFake()
	recorder := NewRecorder(broker)
	ctx := context.Background()
	for minute := range 5 {
		if err := recorder.Seen(ctx, "t-a", "d-1", at(9, minute)); err != nil {
			t.Fatal(err)
		}
	}
	if err := recorder.Seen(ctx, "t-b", "d-2", at(9, 42)); err != nil {
		t.Fatal(err)
	}
	buckets, err := recorder.Close(ctx, at(9, 0))
	if err != nil {
		t.Fatal(err)
	}
	if len(buckets) != 2 {
		t.Fatalf("buckets = %+v", buckets)
	}
	byDevice := map[string]Bucket{}
	for _, bucket := range buckets {
		byDevice[bucket.DeviceID] = bucket
	}
	if byDevice["d-1"].Minutes != 5 || byDevice["d-2"].Minutes != 1 {
		t.Fatalf("minutes crossed devices: %+v", byDevice)
	}
	if byDevice["d-2"].TenantID != "t-b" {
		t.Fatalf("tenant crossed devices: %+v", byDevice["d-2"])
	}
}

// A recorder with no broker is a gateway running without Redis, which is a
// supported configuration: it records nothing and fails nothing.
func TestNoBrokerIsNotAnError(t *testing.T) {
	var recorder *Recorder
	if err := recorder.Seen(context.Background(), "t", "d", at(9, 0)); err != nil {
		t.Fatal(err)
	}
	buckets, err := recorder.Close(context.Background(), at(9, 0))
	if err != nil || buckets != nil {
		t.Fatalf("buckets = %+v, err = %v", buckets, err)
	}
}
