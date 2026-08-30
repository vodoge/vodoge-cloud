package uptime

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/tenant"
)

// Store is where closed hours are kept. Redis holds the hour in progress;
// everything here has survived a flush and is the record.
type Store struct {
	DB *sql.DB
}

// Save writes one tenant's buckets.
//
// Grouped by tenant by the caller because each group is one RLS transaction:
// `app.current_tenant_id()` is what the row's tenant column is filled from, so
// a mixed batch could not be written in one statement even if it were sorted.
func (store Store) Save(ctx context.Context, tenantID string, buckets []Bucket) error {
	if store.DB == nil || len(buckets) == 0 {
		return nil
	}
	return tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		for _, bucket := range buckets {
			// ON CONFLICT takes the larger of the two rather than overwriting.
			// A second flush of an hour should not happen -- Close clears what
			// it read -- and if one ever does, the reading with more minutes in
			// it is the one that saw more of the hour. Overwriting would let a
			// partial re-run erase a full hour.
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO app.device_uptime
				    (tenant_id, device_id, hour, minutes_online, written_at)
				VALUES (app.current_tenant_id(), $1::uuid, $2, $3, now())
				ON CONFLICT (tenant_id, device_id, hour) DO UPDATE
				   SET minutes_online = greatest(
				           app.device_uptime.minutes_online, excluded.minutes_online),
				       written_at = now()`,
				bucket.DeviceID, bucket.Hour, bucket.Minutes,
			); err != nil {
				return fmt.Errorf("uptime save %s %s: %w", bucket.DeviceID, bucket.Hour, err)
			}
		}
		return nil
	})
}

// Flush closes every hour before the one `now` is in and persists it.
//
// `lookback` hours are swept rather than only the previous one, so a gateway
// that was down for a while still collects what Redis kept. Sweeping an hour
// with nothing in it costs one SMEMBERS and produces no rows.
func Flush(
	ctx context.Context,
	recorder *Recorder,
	store Store,
	now time.Time,
	lookback int,
) (int, error) {
	if recorder == nil || store.DB == nil {
		return 0, nil
	}
	if lookback < 1 {
		lookback = 1
	}
	current := now.UTC().Truncate(time.Hour)
	written := 0
	var failure error
	for step := 1; step <= lookback; step++ {
		hour := current.Add(-time.Duration(step) * time.Hour)
		buckets, err := recorder.Close(ctx, hour)
		if err != nil {
			// Keep whatever came back: Close returns the buckets it read even
			// when the clear afterwards failed, and dropping them would lose an
			// hour that is no longer in Redis.
			failure = err
		}
		byTenant := map[string][]Bucket{}
		for _, bucket := range buckets {
			byTenant[bucket.TenantID] = append(byTenant[bucket.TenantID], bucket)
		}
		for tenantID, group := range byTenant {
			if err := store.Save(ctx, tenantID, group); err != nil {
				failure = err
				continue
			}
			written += len(group)
		}
	}
	return written, failure
}
