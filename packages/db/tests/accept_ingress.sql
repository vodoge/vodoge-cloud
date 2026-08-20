\set ON_ERROR_STOP on

SET ROLE vodoge_app;

BEGIN;
SET LOCAL app.tenant_id = '66666666-6666-6666-6666-666666666666';

INSERT INTO app.devices (id, tenant_id, imei, name, vertical)
VALUES (
    'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
    '66666666-6666-6666-6666-666666666666',
    '860000000000006',
    'accept-ingress-device',
    'cn'
);

DO $$
DECLARE
    v_status text;
    v_committed bigint;
    v_missing jsonb;
BEGIN
    PERFORM * FROM app.accept_ingress(
        '66666666-6666-6666-6666-666666666666',
        'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
        1,
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01',
        'SmsReceived',
        '{"peer":"10086","body":"one"}'::jsonb
    );
    PERFORM * FROM app.accept_ingress(
        '66666666-6666-6666-6666-666666666666',
        'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
        2,
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa02',
        'SmsReceived',
        '{"peer":"10086","body":"two"}'::jsonb
    );
    PERFORM * FROM app.accept_ingress(
        '66666666-6666-6666-6666-666666666666',
        'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
        4,
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa04',
        'SmsReceived',
        '{"peer":"10086","body":"four"}'::jsonb
    );

    SELECT a.status, a.committed_through, a.missing_ranges
      INTO v_status, v_committed, v_missing
      FROM app.accept_ingress(
        '66666666-6666-6666-6666-666666666666',
        'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
        5,
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa05',
        'SmsReceived',
        '{"peer":"10086","body":"five"}'::jsonb
      ) AS a;
    IF v_status <> 'inserted' OR v_committed <> 2
        OR v_missing <> '[{"from":"3","through":"3"}]'::jsonb THEN
        RAISE EXCEPTION 'hole window status=% committed=% missing=%',
            v_status, v_committed, v_missing;
    END IF;

    SELECT a.status, a.committed_through
      INTO v_status, v_committed
      FROM app.accept_ingress(
        '66666666-6666-6666-6666-666666666666',
        'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
        1,
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01',
        'SmsReceived',
        '{"peer":"10086","body":"one"}'::jsonb
      ) AS a;
    IF v_status <> 'duplicate' OR v_committed <> 2 THEN
        RAISE EXCEPTION 'duplicate status=% committed=%', v_status, v_committed;
    END IF;

    BEGIN
        PERFORM * FROM app.accept_ingress(
            '66666666-6666-6666-6666-666666666666',
            'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
            1,
            'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbb01',
            'SmsReceived',
            '{"peer":"10086","body":"other"}'::jsonb
        );
        RAISE EXCEPTION 'conflicting seq 1 was accepted';
    EXCEPTION WHEN exclusion_violation THEN
        NULL;
    END;

    SELECT a.status, a.committed_through, a.missing_ranges
      INTO v_status, v_committed, v_missing
      FROM app.accept_ingress(
        '66666666-6666-6666-6666-666666666666',
        'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
        3,
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa03',
        'SmsReceived',
        '{"peer":"10086","body":"three"}'::jsonb
      ) AS a;
    IF v_status <> 'inserted' OR v_committed <> 5 OR v_missing <> '[]'::jsonb THEN
        RAISE EXCEPTION 'fill window status=% committed=% missing=%',
            v_status, v_committed, v_missing;
    END IF;
END
$$;
COMMIT;
