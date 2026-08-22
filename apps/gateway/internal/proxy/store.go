package proxy

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/tenant"
)

// Store reads and writes a tenant's proxy configuration.
type Store interface {
	Upstreams(ctx context.Context, tenantID string) ([]Upstream, error)
	SaveUpstream(ctx context.Context, tenantID string, upstream Upstream) (string, error)
	DeleteUpstream(ctx context.Context, tenantID, id string) error
	RecordProbe(ctx context.Context, tenantID, id string, probe map[string]any, at time.Time) error

	Instances(ctx context.Context, tenantID, deviceID string) ([]Instance, error)
	SaveInstance(ctx context.Context, tenantID string, instance Instance) (string, error)
	DeleteInstance(ctx context.Context, tenantID, id string) error

	CountryRules(ctx context.Context, tenantID string) ([]CountryRule, error)
	SaveCountryRule(ctx context.Context, tenantID string, rule CountryRule) error
	DeleteCountryRule(ctx context.Context, tenantID, code string) error

	Traffic(ctx context.Context, tenantID string, since time.Time) ([]TrafficPoint, error)
	AddTraffic(ctx context.Context, tenantID string, points []TrafficPoint) error
}

// SQL is the PostgreSQL store, reading through the tenant's RLS context.
type SQL struct{ DB *sql.DB }

func (store SQL) Upstreams(ctx context.Context, tenantID string) ([]Upstream, error) {
	out := []Upstream{}
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `
			SELECT id::text, name, address, protocol,
			       coalesce(username, ''), password IS NOT NULL AND password <> '',
			       enabled, last_probe, last_probe_at
			  FROM app.upstream_proxies
			 ORDER BY name`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item Upstream
			var probe []byte
			var probeAt sql.NullTime
			if err := rows.Scan(
				&item.ID, &item.Name, &item.Address, &item.Protocol,
				&item.Username, &item.HasPassword, &item.Enabled, &probe, &probeAt,
			); err != nil {
				return err
			}
			if len(probe) > 0 {
				_ = json.Unmarshal(probe, &item.LastProbe)
			}
			if probeAt.Valid {
				ms := probeAt.Time.UnixMilli()
				item.LastProbeAt = &ms
			}
			out = append(out, item)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func (store SQL) SaveUpstream(
	ctx context.Context,
	tenantID string,
	upstream Upstream,
) (string, error) {
	var id string
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		if upstream.ID == "" {
			return tx.QueryRowContext(ctx, `
				INSERT INTO app.upstream_proxies
				    (tenant_id, name, address, protocol, username, password, enabled)
				VALUES (app.current_tenant_id(), $1, $2, $3, nullif($4, ''), nullif($5, ''), $6)
				RETURNING id::text`,
				upstream.Name, upstream.Address, upstream.Protocol,
				upstream.Username, upstream.Password, upstream.Enabled,
			).Scan(&id)
		}
		// An empty password on update means "unchanged": the console was never
		// given the stored one, so it cannot send it back.
		return tx.QueryRowContext(ctx, `
			UPDATE app.upstream_proxies
			   SET name = $2, address = $3, protocol = $4,
			       username = nullif($5, ''),
			       password = CASE WHEN $6 = '' THEN password ELSE $6 END,
			       enabled = $7, updated_at = now()
			 WHERE id = $1::uuid
			RETURNING id::text`,
			upstream.ID, upstream.Name, upstream.Address, upstream.Protocol,
			upstream.Username, upstream.Password, upstream.Enabled,
		).Scan(&id)
	})
	return id, err
}

func (store SQL) DeleteUpstream(ctx context.Context, tenantID, id string) error {
	return tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx,
			`DELETE FROM app.upstream_proxies WHERE id = $1::uuid`, id)
		return err
	})
}

func (store SQL) RecordProbe(
	ctx context.Context,
	tenantID, id string,
	probe map[string]any,
	at time.Time,
) error {
	encoded, err := json.Marshal(probe)
	if err != nil {
		return err
	}
	return tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			UPDATE app.upstream_proxies
			   SET last_probe = $2::jsonb, last_probe_at = $3
			 WHERE id = $1::uuid`, id, string(encoded), at)
		return err
	})
}

func (store SQL) Instances(ctx context.Context, tenantID, deviceID string) ([]Instance, error) {
	out := []Instance{}
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `
			SELECT id::text, device_id::text, name, modem_imei, protocol,
			       listen_addr, listen_port, auth_enabled,
			       coalesce(username, ''), password IS NOT NULL AND password <> '',
			       coalesce(upstream_id::text, ''), enabled
			  FROM app.proxy_instances
			 WHERE ($1 = '' OR device_id = $1::uuid)
			 ORDER BY name`, deviceID)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var item Instance
			if err := rows.Scan(
				&item.ID, &item.DeviceID, &item.Name, &item.ModemIMEI, &item.Protocol,
				&item.ListenAddr, &item.ListenPort, &item.AuthEnabled,
				&item.Username, &item.HasPassword, &item.UpstreamID, &item.Enabled,
			); err != nil {
				return err
			}
			out = append(out, item)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func (store SQL) SaveInstance(
	ctx context.Context,
	tenantID string,
	instance Instance,
) (string, error) {
	var id string
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		if instance.ID == "" {
			return tx.QueryRowContext(ctx, `
				INSERT INTO app.proxy_instances
				    (tenant_id, device_id, name, modem_imei, protocol,
				     listen_addr, listen_port, auth_enabled, username, password,
				     upstream_id, enabled)
				VALUES (app.current_tenant_id(), $1::uuid, $2, $3, $4,
				        $5, $6, $7, nullif($8, ''), nullif($9, ''),
				        nullif($10, '')::uuid, $11)
				RETURNING id::text`,
				instance.DeviceID, instance.Name, instance.ModemIMEI, instance.Protocol,
				instance.ListenAddr, instance.ListenPort, instance.AuthEnabled,
				instance.Username, instance.Password, instance.UpstreamID, instance.Enabled,
			).Scan(&id)
		}
		return tx.QueryRowContext(ctx, `
			UPDATE app.proxy_instances
			   SET name = $2, modem_imei = $3, protocol = $4,
			       listen_addr = $5, listen_port = $6, auth_enabled = $7,
			       username = nullif($8, ''),
			       password = CASE WHEN $9 = '' THEN password ELSE $9 END,
			       upstream_id = nullif($10, '')::uuid,
			       enabled = $11, updated_at = now()
			 WHERE id = $1::uuid
			RETURNING id::text`,
			instance.ID, instance.Name, instance.ModemIMEI, instance.Protocol,
			instance.ListenAddr, instance.ListenPort, instance.AuthEnabled,
			instance.Username, instance.Password, instance.UpstreamID, instance.Enabled,
		).Scan(&id)
	})
	return id, err
}

func (store SQL) DeleteInstance(ctx context.Context, tenantID, id string) error {
	return tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx,
			`DELETE FROM app.proxy_instances WHERE id = $1::uuid`, id)
		return err
	})
}

func (store SQL) CountryRules(ctx context.Context, tenantID string) ([]CountryRule, error) {
	out := []CountryRule{}
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `
			SELECT country_code, coalesce(upstream_id::text, '')
			  FROM app.upstream_proxy_country_rules
			 ORDER BY country_code`)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var rule CountryRule
			if err := rows.Scan(&rule.CountryCode, &rule.UpstreamID); err != nil {
				return err
			}
			out = append(out, rule)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func (store SQL) SaveCountryRule(ctx context.Context, tenantID string, rule CountryRule) error {
	return tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `
			INSERT INTO app.upstream_proxy_country_rules (tenant_id, country_code, upstream_id)
			VALUES (app.current_tenant_id(), $1, nullif($2, '')::uuid)
			ON CONFLICT (tenant_id, country_code) DO UPDATE
			   SET upstream_id = EXCLUDED.upstream_id, updated_at = now()`,
			rule.CountryCode, rule.UpstreamID)
		return err
	})
}

func (store SQL) DeleteCountryRule(ctx context.Context, tenantID, code string) error {
	return tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx,
			`DELETE FROM app.upstream_proxy_country_rules WHERE country_code = $1`, code)
		return err
	})
}

func (store SQL) Traffic(
	ctx context.Context,
	tenantID string,
	since time.Time,
) ([]TrafficPoint, error) {
	out := []TrafficPoint{}
	err := tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(ctx, `
			SELECT instance_id::text, hour, bytes_up, bytes_down, connections
			  FROM app.proxy_traffic
			 WHERE hour >= $1
			 ORDER BY hour DESC, instance_id`, since)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var point TrafficPoint
			var hour time.Time
			if err := rows.Scan(
				&point.InstanceID, &hour, &point.BytesUp, &point.BytesDown, &point.Connections,
			); err != nil {
				return err
			}
			point.Hour = hour.UnixMilli()
			out = append(out, point)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// AddTraffic folds an edge's report into the hourly totals.
//
// Added rather than replaced: the edge reports what it has counted since its
// last report, and a device that reconnects mid-hour would otherwise erase the
// part of the hour it already sent.
func (store SQL) AddTraffic(ctx context.Context, tenantID string, points []TrafficPoint) error {
	if len(points) == 0 {
		return nil
	}
	return tenant.Transact(ctx, store.DB, tenantID, func(tx *sql.Tx) error {
		for _, point := range points {
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO app.proxy_traffic
				    (tenant_id, instance_id, hour, bytes_up, bytes_down, connections)
				VALUES (app.current_tenant_id(), $1::uuid, date_trunc('hour', $2::timestamptz),
				        $3, $4, $5)
				ON CONFLICT (tenant_id, instance_id, hour) DO UPDATE
				   SET bytes_up = app.proxy_traffic.bytes_up + EXCLUDED.bytes_up,
				       bytes_down = app.proxy_traffic.bytes_down + EXCLUDED.bytes_down,
				       connections = app.proxy_traffic.connections + EXCLUDED.connections`,
				point.InstanceID, time.UnixMilli(point.Hour),
				point.BytesUp, point.BytesDown, point.Connections,
			); err != nil {
				return err
			}
		}
		return nil
	})
}
