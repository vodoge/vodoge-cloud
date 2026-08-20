\set ON_ERROR_STOP on

SET ROLE vodoge_app;

BEGIN;
SET LOCAL app.tenant_id = '88888888-8888-8888-8888-888888888888';

INSERT INTO app.tenants (id, slug, name, status, region)
VALUES (
    '88888888-8888-8888-8888-888888888888',
    'project-ingress',
    'Project Ingress',
    'active',
    'cn'
);

INSERT INTO app.devices (id, tenant_id, imei, name, vertical)
VALUES (
    'dddddddd-dddd-dddd-dddd-dddddddddddd',
    '88888888-8888-8888-8888-888888888888',
    '860000000000008',
    'project-ingress-device',
    'cn'
);

DO $$
DECLARE
    v_count integer;
    v_body text;
    v_peer text;
    v_last_seen timestamptz;
    v_state jsonb;
BEGIN
    PERFORM * FROM app.accept_ingress(
        '88888888-8888-8888-8888-888888888888',
        'dddddddd-dddd-dddd-dddd-dddddddddddd',
        1,
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa11',
        'SmsReceived',
        '{"peer":"10086","body":"one","bearer":"cellular","received_at":1700000000000}'::jsonb
    );
    PERFORM * FROM app.accept_ingress(
        '88888888-8888-8888-8888-888888888888',
        'dddddddd-dddd-dddd-dddd-dddddddddddd',
        1,
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa11',
        'SmsReceived',
        '{"peer":"10086","body":"one","bearer":"cellular","received_at":1700000000000}'::jsonb
    );
    PERFORM * FROM app.accept_ingress(
        '88888888-8888-8888-8888-888888888888',
        'dddddddd-dddd-dddd-dddd-dddddddddddd',
        2,
        'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa12',
        'DeviceState',
        '{"observed_at":1700000001000,"modems":[]}'::jsonb
    );

    SELECT count(*), min(body), min(peer)
      INTO v_count, v_body, v_peer
      FROM app.messages;
    IF v_count <> 1 OR v_body <> 'one' OR v_peer <> '10086' THEN
        RAISE EXCEPTION 'projected messages count=% body=% peer=%', v_count, v_body, v_peer;
    END IF;

    SELECT last_seen_at, state
      INTO v_last_seen, v_state
      FROM app.devices
     WHERE id = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    IF v_last_seen IS NULL THEN
        RAISE EXCEPTION 'device last_seen_at was not updated';
    END IF;
    IF v_state->'modems' IS NULL THEN
        RAISE EXCEPTION 'device state was not replaced by DeviceState payload: %', v_state;
    END IF;
END
$$;
COMMIT;

BEGIN;
SET LOCAL app.tenant_id = '99999999-9999-9999-9999-999999999999';

INSERT INTO app.tenants (id, slug, name, status, region)
VALUES (
    '99999999-9999-9999-9999-999999999999',
    'project-ingress-b',
    'Project Ingress B',
    'active',
    'intl'
);

DO $$
DECLARE
    v_count integer;
BEGIN
    SELECT count(*) INTO v_count FROM app.messages;
    IF v_count <> 0 THEN
        RAISE EXCEPTION 'tenant B read % tenant A messages', v_count;
    END IF;

    SELECT count(*) INTO v_count FROM app.devices;
    IF v_count <> 0 THEN
        RAISE EXCEPTION 'tenant B read % tenant A devices', v_count;
    END IF;
END
$$;
COMMIT;

RESET ROLE;
