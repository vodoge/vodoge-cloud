-- 审计里不许留装机码的明文 —— 存量行和新行都不许。
--
-- 🔴 0070 之前，`create_enrollment_code` 的 detail 里存着明文码，而
--    `GET /v1/audit` 把 detail 原样发回去、且没有角色闸（只读会话也读得到）。
--    码是活凭据：`POST /v1/enroll` 只认「租户 id + 码」，不要求客户端证书。
--
-- 这个文件验两件事：
--
--   ① 0070 真的把存量行里的 `code` 删掉了，而且**保留了那一行**（谁、什么时候、
--      哪一行 id）——「删掉整行」才是真的丢审计。
--   ② 它留下了 `code_redacted` 标记。没有标记的话，「清理过的旧行」和「改动之后
--      写的新行」在库里长得一模一样，而两者的意思不同：前者曾经泄露过。
--
-- ⚠️ 这个测试**自己造一条旧格式的行**，而不是指望库里正好有一条。生产上
--    `app.enrollment_codes` 是 0 行（2026-09-13 核过），所以那里本来就没有存量
--    泄露 —— 但这条断言要守的是「任何一个已部署的库跑完迁移之后都不再泄露」，
--    那就必须自己把泄露造出来。指望环境里有数据的测试，在干净库上是绿的谎。
BEGIN;

-- `id` 没有默认值，得自己给（和 notification_attempts.sql 等同一个写法）。
INSERT INTO app.tenants (id, slug, name, status, region)
VALUES ('70707070-7070-7070-7070-707070707070', 'audit-redact', 'Audit Redact', 'active', 'cn');

DO $$
DECLARE
    v_tenant uuid := '70707070-7070-7070-7070-707070707070';
    v_row    uuid;
    v_detail jsonb;
BEGIN
    PERFORM set_config('app.tenant_id', v_tenant::text, true);

    -- ① 造一条 0070 之前那种格式的行。
    INSERT INTO app.audit_log (tenant_id, actor, action, target, detail)
         VALUES (v_tenant, 'console', 'create_enrollment_code', gen_random_uuid()::text,
                 jsonb_build_object('code', 'K7M2XQ4B', 'expires_at', 1789000000000))
      RETURNING id INTO v_row;

    -- 先确认它真的是「泄露的」状态 —— 否则下面那一步在验一个本来就干净的行。
    SELECT detail INTO v_detail FROM app.audit_log WHERE id = v_row;
    IF NOT (v_detail ? 'code') THEN
        RAISE EXCEPTION '造出来的旧行里没有 code，这个测试在验空气';
    END IF;

    -- ② 跑 0070 的那一句。
    --
    -- 🔴 照原文抄的一句，而不是「意思一样」的一句 —— 分家了就测不到它。
    --    `apps/gateway/internal/enroll/certificates_test.go` 里有一条对照断言
    --    用同样的办法把那边的复制品钉在实现上；这里对应的是迁移，而迁移是
    --    一次性的，所以这条语句就是它的唯一副本。
    UPDATE app.audit_log
       SET detail = (detail - 'code') || jsonb_build_object('code_redacted', true)
     WHERE action = 'create_enrollment_code'
       AND detail ? 'code';

    SELECT detail INTO v_detail FROM app.audit_log WHERE id = v_row;
    IF v_detail IS NULL THEN
        RAISE EXCEPTION '清理把整行删掉了 —— 审计要回答「谁在什么时候发过码」，行不能没';
    END IF;
    IF v_detail ? 'code' THEN
        RAISE EXCEPTION '明文码还在 detail 里：%', v_detail;
    END IF;
    IF (v_detail -> 'expires_at') IS NULL THEN
        RAISE EXCEPTION '过期时间被一起删掉了 —— 只该删 code 那一个键：%', v_detail;
    END IF;
    IF (v_detail -> 'code_redacted') IS DISTINCT FROM 'true'::jsonb THEN
        RAISE EXCEPTION
            '没有留下 code_redacted 标记，于是「清理过的旧行」和「新行」再也分不开：%',
            v_detail;
    END IF;

    -- ③ 幂等：再跑一次，一行都不该动。
    DECLARE
        v_before jsonb := v_detail;
    BEGIN
        UPDATE app.audit_log
           SET detail = (detail - 'code') || jsonb_build_object('code_redacted', true)
         WHERE action = 'create_enrollment_code'
           AND detail ? 'code';
        SELECT detail INTO v_detail FROM app.audit_log WHERE id = v_row;
        IF v_detail IS DISTINCT FROM v_before THEN
            RAISE EXCEPTION '再跑一次改动了已经清理过的行：% → %', v_before, v_detail;
        END IF;
    END;

    -- ④ 别的动作不许被顺手改。
    --
    -- ⚠️ 这一条是为了钉住那个 `action = 'create_enrollment_code'` 条件。少了它，
    --    这个迁移会去改写每一条带 `code` 键的审计 —— 而 detail 是自由 jsonb，
    --    别的动作里的 `code` 可能是完全无关的东西（错误码、国家码）。
    INSERT INTO app.audit_log (tenant_id, actor, action, target, detail)
         VALUES (v_tenant, 'console', 'update_settings', 'x',
                 jsonb_build_object('code', 'zh-CN'))
      RETURNING id INTO v_row;
    UPDATE app.audit_log
       SET detail = (detail - 'code') || jsonb_build_object('code_redacted', true)
     WHERE action = 'create_enrollment_code'
       AND detail ? 'code';
    SELECT detail INTO v_detail FROM app.audit_log WHERE id = v_row;
    IF NOT (v_detail ? 'code') THEN
        RAISE EXCEPTION '清理动到了别的动作的 detail：%', v_detail;
    END IF;
END
$$;

COMMIT;
