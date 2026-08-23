-- Give app.ingress a retention window, without lying to the device about what
-- the cloud still holds.
--
-- The journal grows at ~26k rows/day on this deployment (measured
-- 2026-08-23: 65964 rows over 2.5 days, 45 MB, 715 bytes/row). Nothing was
-- ever removed. That is not urgent -- 24 GB free divided by 18 MB/day is over
-- three years -- but "nothing is ever removed" is not a policy, it is the
-- absence of one, and the day it matters is the day there is no time to design
-- one.
--
-- # Why a naive DELETE breaks the uplink
--
-- app.ingress_window computes committed_through as the longest run of
-- sequences starting at 1, read off the table itself (0004: "The contiguous
-- prefix is computed from the table, never from the edge cursors"). The
-- gateway hands that number to the device, and the device keeps every record
-- until it is covered by it.
--
-- So `DELETE FROM app.ingress WHERE received_at < ...` does this: the
-- ROW_NUMBER() comparison stops matching at the very first surviving row,
-- committed_through collapses to 0, and the next Snapshot tells the device
-- that nothing has ever been received. The device then replays its entire
-- durable outbox from seq 1, and missing_ranges reports one gap covering every
-- sequence ever issued. Deleting one row would do it.
--
-- # The fix: record what was pruned, and count from there
--
-- app.ingress_pruned holds one high-water mark per device: "sequences at or
-- below this were received and acknowledged; they are no longer on disk."
-- ingress_window starts its run at that mark instead of at zero. With no row
-- and no pruning the mark is 0 and the function computes exactly what it
-- computed before -- the change is a no-op until something is actually pruned.
--
-- The mark only ever moves forward, and only over a range proven contiguous
-- first. Overstating it is the one failure that loses data the cloud cannot
-- get back: the device would be told a sequence is safe and would drop its
-- only copy.
--
-- # What gets deleted, and what does not
--
-- Only kind = 'DeviceState', and only after 30 days.
--
-- DeviceState is 99.6% of the journal (65715 of 65964 rows) and is the only
-- kind whose content is fully superseded elsewhere: app.devices and app.modems
-- carry every field it reports, at its current value. Its journal copy answers
-- one narrower question -- "what did the module say at 14:32 last Tuesday" --
-- and thirty days is a generous answer to it. At the measured rate the window
-- bounds the table at roughly 800k rows / 550 MB, about 2% of free disk, which
-- turns unbounded growth into a constant.
--
-- SmsReceived, SmsStatusReport, CommandResult, Alert and the Unstorable
-- tombstones from 0031 are never deleted. They total 249 rows, about 90 a day
-- -- 33k rows a year, some 24 MB -- and they are the rows anyone actually goes
-- back to read. Expiring them would pay nothing for the only loss that would
-- hurt. app.ingress is the one place a device's uplink can be retraced, so
-- when this policy is wrong it is wrong in the direction of keeping too much.
--
-- # What this deliberately is not
--
-- Not partitioning, not archival to object storage, not a configurable policy
-- surface. One window, one function, called from the path that already holds a
-- tenant id.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The high-water mark.
-- ---------------------------------------------------------------------------
--
-- Owned by vodoge_owner to match app.ingress: the two functions that read and
-- write it are SECURITY DEFINER owned by vodoge_owner, and FORCE row-level
-- security applies to the owner too, so this is isolation-preserving rather
-- than a way around it.
--
-- ON DELETE CASCADE so app.delete_device (0024) keeps working untouched. It
-- deletes app.ingress and then app.devices; without the cascade a deleted
-- device would leave a mark behind, and a device re-enrolled onto the same id
-- would inherit a prefix it never sent.

CREATE TABLE app.ingress_pruned (
    tenant_id uuid NOT NULL,
    device_id uuid NOT NULL,
    -- Sequences <= this were received, acknowledged, and are no longer stored.
    pruned_through bigint NOT NULL,
    rows_pruned bigint NOT NULL DEFAULT 0,
    first_pruned_at timestamptz NOT NULL DEFAULT now(),
    last_pruned_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ingress_pruned_pkey PRIMARY KEY (tenant_id, device_id),
    CONSTRAINT ingress_pruned_device_fkey
        FOREIGN KEY (tenant_id, device_id)
        REFERENCES app.devices (tenant_id, id) ON DELETE CASCADE,
    CONSTRAINT ingress_pruned_through_positive CHECK (pruned_through > 0)
);

ALTER TABLE app.ingress_pruned OWNER TO vodoge_owner;

ALTER TABLE app.ingress_pruned ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.ingress_pruned FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON app.ingress_pruned
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

REVOKE ALL ON app.ingress_pruned FROM PUBLIC;
-- SELECT only. The mark is written by app.prune_ingress and by nothing else;
-- an application role that could raise it could make the cloud claim records
-- it never stored.
GRANT SELECT ON app.ingress_pruned TO vodoge_app;

COMMENT ON TABLE app.ingress_pruned IS
    'Per-device high-water mark of ingress sequences that were received, acknowledged and then deleted by retention. app.ingress_window counts its contiguous prefix from here.';

-- ---------------------------------------------------------------------------
-- 2. Teach the window function where the journal now starts.
-- ---------------------------------------------------------------------------
--
-- The only change from 0004 is the base. With no mark, v_base is 0 and
-- `i.seq > 0` excludes nothing (ingress_seq_positive already requires it), so
-- an unpruned device gets byte-identical answers.
--
-- Rows below the mark that survived -- an old SmsReceived kept by the kind
-- filter -- are excluded from the run on purpose. They sit below an
-- acknowledged prefix, so they can neither extend it nor open a gap in it.
--
-- Known consequence, recorded rather than guarded: a device that rewound its
-- sequence counter below the mark would have its replayed records treated as
-- new inserts instead of duplicates, because the rows they would have
-- collided with are gone. Guarding it means teaching app.accept_ingress about
-- the mark, and that function is the single projection writer and has been
-- redefined by eight migrations; the change is larger than the risk. Nothing
-- rewinds today: the edge outbox assigns sequences from a durable monotonic
-- counter, and the mark never advances past what the device was already told
-- was committed.

CREATE OR REPLACE FUNCTION app.ingress_window(
    p_tenant_id uuid,
    p_device_id uuid
)
RETURNS TABLE (
    committed_through bigint,
    missing_ranges jsonb,
    more_missing boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
    v_base bigint := 0;
    v_committed bigint := 0;
    v_prev bigint;
    v_seq bigint;
    v_from bigint;
    v_ranges jsonb := '[]'::jsonb;
    v_more boolean := false;
    v_count integer := 0;
BEGIN
    IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() THEN
        RAISE EXCEPTION 'tenant context does not match ingress tenant'
            USING ERRCODE = '42501';
    END IF;

    SELECT p.pruned_through
      INTO v_base
      FROM app.ingress_pruned AS p
     WHERE p.tenant_id = p_tenant_id
       AND p.device_id = p_device_id;
    v_base := COALESCE(v_base, 0);

    SELECT COALESCE(MAX(t.seq), v_base)
      INTO v_committed
      FROM (
          SELECT i.seq,
                 v_base + ROW_NUMBER() OVER (ORDER BY i.seq) AS rn
            FROM app.ingress AS i
           WHERE i.tenant_id = p_tenant_id
             AND i.device_id = p_device_id
             AND i.seq > v_base
      ) AS t
     WHERE t.seq = t.rn;

    v_prev := v_committed;
    FOR v_seq IN
        SELECT i.seq
          FROM app.ingress AS i
         WHERE i.tenant_id = p_tenant_id
           AND i.device_id = p_device_id
           AND i.seq > v_committed
         ORDER BY i.seq
    LOOP
        IF v_seq > v_prev + 1 THEN
            IF v_count >= 128 THEN
                v_more := true;
                EXIT;
            END IF;
            v_from := v_prev + 1;
            v_ranges := v_ranges || jsonb_build_array(
                jsonb_build_object(
                    'from', (v_from)::text,
                    'through', (v_seq - 1)::text
                )
            );
            v_count := v_count + 1;
        END IF;
        v_prev := v_seq;
    END LOOP;

    committed_through := v_committed;
    missing_ranges := v_ranges;
    more_missing := v_more;
    RETURN NEXT;
END
$$;

ALTER FUNCTION app.ingress_window(uuid, uuid) OWNER TO vodoge_owner;
REVOKE ALL ON FUNCTION app.ingress_window(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.ingress_window(uuid, uuid) TO vodoge_app;

COMMENT ON FUNCTION app.ingress_window(uuid, uuid) IS
    'Contiguous durable prefix for one device, counted from app.ingress_pruned so retention does not make the cloud forget what it acknowledged.';

-- ---------------------------------------------------------------------------
-- 3. The prune itself.
-- ---------------------------------------------------------------------------
--
-- Per tenant, because the caller is the scheduler tick and a tenant id is
-- exactly what it holds. There is no global form and cannot be one:
-- app.tenants is under FORCE row-level security keyed to
-- app.current_tenant_id(), so not even a SECURITY DEFINER function owned by
-- the table owner can enumerate tenants (0033 says the same thing at length).
--
-- p_retain carries the policy as a default rather than as a literal in the
-- body, so the window has one spelling and an operator can still run a
-- one-off reclaim with a shorter one without editing a function. p_limit
-- bounds a single pass by sequence range, which matters only for the first
-- catch-up; in steady state a 15-second tick has a handful of rows to retire.
--
-- The ceiling is chosen as "one below the oldest record still inside the
-- window", not as "the newest record outside it". Those differ: received_at
-- is not monotonic in seq (22 inversions in production, from records that
-- arrive out of order after a reconnect), and taking the newest old row would
-- let the mark step over rows that must be kept, stranding them below the
-- prefix where nothing would ever look at them again.

CREATE OR REPLACE FUNCTION app.prune_ingress(
    p_tenant_id uuid,
    p_now timestamptz,
    p_retain interval DEFAULT interval '30 days',
    p_limit integer DEFAULT 20000
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
DECLARE
    v_cutoff timestamptz;
    v_device uuid;
    v_base bigint;
    v_ceiling bigint;
    v_fresh bigint;
    v_present bigint;
    v_deleted integer;
    v_total integer := 0;
BEGIN
    IF p_tenant_id IS DISTINCT FROM app.current_tenant_id() THEN
        RAISE EXCEPTION 'tenant context does not match ingress retention tenant'
            USING ERRCODE = '42501';
    END IF;
    IF p_retain IS NULL OR p_retain < interval '1 hour' THEN
        RAISE EXCEPTION 'ingress retention window must be at least one hour, got %', p_retain
            USING ERRCODE = '22023';
    END IF;
    IF p_limit IS NULL OR p_limit <= 0 THEN
        RAISE EXCEPTION 'ingress retention batch limit must be positive, got %', p_limit
            USING ERRCODE = '22023';
    END IF;

    v_cutoff := p_now - p_retain;

    -- app.devices rather than a DISTINCT over app.ingress: the journal is the
    -- large table and this runs every tick.
    FOR v_device IN
        SELECT d.id FROM app.devices AS d WHERE d.tenant_id = p_tenant_id
    LOOP
        SELECT p.pruned_through
          INTO v_base
          FROM app.ingress_pruned AS p
         WHERE p.tenant_id = p_tenant_id
           AND p.device_id = v_device;
        v_base := COALESCE(v_base, 0);

        -- Oldest record above the mark that is still inside the window.
        -- Everything below it is outside the window by definition, whatever
        -- order it arrived in. Cheap: the primary key is (device_id, seq), so
        -- once the mark has caught up this stops on the first row examined.
        SELECT min(i.seq)
          INTO v_fresh
          FROM app.ingress AS i
         WHERE i.tenant_id = p_tenant_id
           AND i.device_id = v_device
           AND i.seq > v_base
           AND i.received_at >= v_cutoff;

        IF v_fresh IS NULL THEN
            -- Every record above the mark has aged out.
            SELECT COALESCE(max(i.seq), v_base)
              INTO v_ceiling
              FROM app.ingress AS i
             WHERE i.tenant_id = p_tenant_id
               AND i.device_id = v_device
               AND i.seq > v_base;
        ELSE
            v_ceiling := v_fresh - 1;
        END IF;

        v_ceiling := LEAST(v_ceiling, v_base + p_limit);
        IF v_ceiling <= v_base THEN
            CONTINUE;
        END IF;

        -- The mark may only cross sequences the cloud really has. A gap in
        -- (v_base, v_ceiling] is a record still owed by the device, and
        -- marking it acknowledged would make the device drop its only copy.
        SELECT count(*)
          INTO v_present
          FROM app.ingress AS i
         WHERE i.tenant_id = p_tenant_id
           AND i.device_id = v_device
           AND i.seq > v_base
           AND i.seq <= v_ceiling;

        IF v_present <> v_ceiling - v_base THEN
            -- Lower the ceiling to the end of the run that is actually there,
            -- rather than skipping the device. Skipping would be safe, but a
            -- gap that never fills would silently switch retention off for
            -- that device and nothing would report it.
            --
            -- Phrased as "the highest sequence sitting in its own position",
            -- the same test app.ingress_window uses, because the tempting
            -- phrasing -- "the first sequence out of position" -- has no
            -- answer when the range holds no rows at all, and a NULL there
            -- reads as "no gap found" and lets the mark cross the whole
            -- range. That is the one direction that loses data: the device
            -- would be told records were stored that never were.
            SELECT COALESCE(max(t.seq), v_base)
              INTO v_ceiling
              FROM (
                  SELECT i.seq,
                         v_base + ROW_NUMBER() OVER (ORDER BY i.seq) AS expected
                    FROM app.ingress AS i
                   WHERE i.tenant_id = p_tenant_id
                     AND i.device_id = v_device
                     AND i.seq > v_base
                     AND i.seq <= v_ceiling
              ) AS t
             WHERE t.seq = t.expected;
            IF v_ceiling <= v_base THEN
                CONTINUE;
            END IF;
        END IF;

        DELETE FROM app.ingress AS i
         WHERE i.tenant_id = p_tenant_id
           AND i.device_id = v_device
           AND i.seq > v_base
           AND i.seq <= v_ceiling
           AND i.kind = 'DeviceState'
           AND i.received_at < v_cutoff;
        GET DIAGNOSTICS v_deleted = ROW_COUNT;

        -- One transaction with the delete, so there is no instant in which
        -- rows are gone and the mark still says they are on disk. GREATEST
        -- because the mark must never move backwards, whatever a concurrent
        -- caller or a replayed argument says.
        INSERT INTO app.ingress_pruned AS p (
            tenant_id, device_id, pruned_through, rows_pruned
        ) VALUES (
            p_tenant_id, v_device, v_ceiling, v_deleted
        )
        ON CONFLICT (tenant_id, device_id) DO UPDATE
        SET pruned_through = GREATEST(p.pruned_through, EXCLUDED.pruned_through),
            rows_pruned = p.rows_pruned + EXCLUDED.rows_pruned,
            last_pruned_at = now();

        v_total := v_total + v_deleted;
    END LOOP;

    RETURN v_total;
END
$$;

ALTER FUNCTION app.prune_ingress(uuid, timestamptz, interval, integer) OWNER TO vodoge_owner;
REVOKE ALL ON FUNCTION app.prune_ingress(uuid, timestamptz, interval, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.prune_ingress(uuid, timestamptz, interval, integer) TO vodoge_app;

COMMENT ON FUNCTION app.prune_ingress(uuid, timestamptz, interval, integer) IS
    'Deletes one tenant''s DeviceState journal rows older than the retention window, advancing app.ingress_pruned so the acknowledged prefix survives the deletion. Other kinds are kept.';

COMMIT;
