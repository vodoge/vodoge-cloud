-- 审计里存着一次性装机码的明文，而审计行是永久的。
--
-- 🔴 `create_enrollment_code` 这个动作的 detail 此前长这样：
--
--      {"code": "K7M2XQ4B", "expires_at": 1789...}
--
--    网关侧已经改掉（不再写 `code`，只留过期时间），但那只对**新行**有效。
--    存量行还在，而 `GET /v1/audit` 把 detail 原样发回去
--    （`internal/audit/log.go` 的 `SELECT … detail … LIMIT 200` →
--    `cmd/gateway/main.go` 的 listAudit 直接 encode，中间没有任何脱敏）。
--
-- ⚠️ 而且那条路**只读账号也能走**：`/v1/audit` 没有角色闸，而网关外面那道
--    `readOnly` 只拦改状态的方法。也就是说一个只读会话可以读到明文码。
--
--    码本身还是活凭据：`POST /v1/enroll` 只认「租户 id + 码」，**不要求客户端
--    证书**（见 internal/enroll/enroll.go 的注释），而 ttl_hours 没有上限。
--    一个没被用掉、还没过期的码泄露出去，等于任何一台机器都能凭它换走一张设备
--    证书。
--
-- ## 为什么是迁移，而不是读取时脱敏
--
-- 读取时脱敏要在每一个读 detail 的地方都记得做一次，而 detail 是自由 jsonb ——
-- 那是一道会被下一个新读者绕过的闸。把值删掉，泄露面就没了。
--
-- 这也是这个仓库的既有做法：0067 在修好过期函数之后，顺手把已经卡住的那几行
-- 补掉了；0024 也会 `UPDATE app.enrollment_codes SET device_id = NULL`。
--
-- ## 保留「发生过这件事」
--
-- 只删 `code` 这一个键，行本身不动。审计要回答的是「谁在什么时候发了一个码」，
-- `actor` / `action` / `target`（那一行的 id）/ `created_at` 全部留着 ——
-- 删掉整行才是真的丢审计。
--
-- 🔴 顺手留一个标记 `"code_redacted": true`，而不是让那个键**无声消失**。
--    一行「没有 code 键」有两种可能的来历：这次清理过的旧行，和改动之后写的新行。
--    两者读起来一样，但意思不同 —— 前者曾经泄露过、后者从未。将来要回答
--    「这个库有没有暴露过装机码」，靠的就是这个标记。
--
-- ⚠️ 幂等：`WHERE detail ? 'code'` 保证再跑一次一行都不动。
BEGIN;

-- 执行者是 `vodoge`（superuser，绕过 RLS），所以这一句会跨所有租户清理 ——
-- 这里正是想要的行为。也正因为 RLS 不生效，条件必须自己写严：只碰
-- `create_enrollment_code` 这一个动作，不去猜别的动作的 detail 里有什么。
UPDATE app.audit_log
   SET detail = (detail - 'code') || jsonb_build_object('code_redacted', true)
 WHERE action = 'create_enrollment_code'
   AND detail ? 'code';

-- ⚠️ 不处理别的动作。
--
-- 这次坐实的只有 `create_enrollment_code` 这一个泄露点，而「detail 里可能还有
-- 别的秘密」是一句没有依据的猜测。凭猜测去改写审计数据，代价是把一段正要用来
-- 查问题的历史删掉 —— 那和这个迁移要防的事一样坏。真发现下一个，再写下一条。

COMMIT;
