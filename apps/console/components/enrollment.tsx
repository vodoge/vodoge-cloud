"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonRow } from "@/components/ui/button-row";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormError, FormHint } from "@/components/ui/form";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { interpolate } from "@/lib/interpolate";
import type { CertificateRow } from "@/lib/catalog";

type Labels = Record<string, string>;

/**
 * 装机：生成一个一次性码，和收回一张证书。
 *
 * 🔴 这两件事在这之前**只能用 psql 和 curl 做** —— 我 2026-09-11 到 09-13
 *    之间把整条链接通（边缘会自己装机、认证会查吊销），而每一次操作都是在
 *    数据库客户端里敲的。M7 的理由是「能把第二台机器交给一个付费客户，而你
 *    不用到场」；一个只能靠 psql 执行的装机和收回，不满足那句话里的任何一半。
 *
 *    设备总览页的空态从很早就写着「先生成一个接入码，再用它启动边缘 agent」
 *    —— 而界面上没有任何地方能生成。这个组件是那句话缺的那一半。
 *
 * ## 码只显示一次，而且这件事在网关侧是真的
 *
 * 一个能被反复读取的一次性凭据不是一次性的，而这个界面如果暗示它还能找回来，
 * 运维就不会在当下把它记下来。所以这里没有「再看一次」。
 *
 * 🔴 但「界面不给」本来只是化妆。做这个界面的时候顺着查下去，发现网关有两处
 *    把明文码交出来：`GET /v1/enrollment-codes` 原样返回它，而
 *    `create_enrollment_code` 的审计明细也存了它 —— 审计行是永久的，所以一个
 *    还没被用掉的码会一直可读。任何有控制台会话的人 curl 一下就拿到全部。
 *
 *    两处都改了（`internal/enroll/codes.go` 的 `CodeSummary` 不带码，
 *    列表的 SQL 里根本不 SELECT 它；审计明细只留过期时间）。OpenAPI 从一开始
 *    就写着这个码「is returned once here」—— 违反那句话的是实现，不是文档。
 *
 * ⚠️ 剩下唯一还能读到它的地方是数据库本身（`app.enrollment_codes.code`），
 *    而那一列是 `POST /v1/enroll` 用来比对的，删不掉。
 *
 * ## 只读账号看不到这两个操作
 *
 * `writable` 是**必需** prop，由页面在服务端解析角色后传下来（和
 * `device-admin.tsx` 同一个约定）。prop 在第一次渲染前就存在，所以不存在
 * 「控件先出现再消失」的那一帧，而 TypeScript 会拒绝一个忘了传它的调用方。
 *
 * ⚠️ 藏起按钮**不是**权限模型。网关在整个路由表外面有一道 `readOnly` 闸，
 * 只读会话的任何写请求都是 403 —— 那才是模型。这里只是不做一个注定被拒的
 * 邀约。
 */
export function Enrollment({
  certificates,
  outstanding,
  writable,
  labels,
}: {
  certificates: CertificateRow[];
  /**
   * 还没被用掉、也还没过期的码有几个 —— **不含码本身**。
   *
   * 🔴 这个数字补的是这个界面自己挖的一个坑：码只显示一次，所以发完之后一刷新，
   *    那个**还活着的凭据在界面上就彻底不存在了**。运维会以为没发过，再发一个，
   *    于是外面漂着两个能装机的秘密而界面一个都不提。
   *
   *    显示「还有 N 个没被用掉」不泄露任何东西（列表端点已经不带码了），但它让
   *    「我是不是已经发过了」这个问题有地方回答。
   */
  outstanding: number;
  writable: boolean;
  labels: Labels;
}) {
  const router = useRouter();
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 正在等确认的那张证书。null = 没有。 */
  const [confirming, setConfirming] = useState<string | null>(null);

  async function mint() {
    // 🔴 藏起按钮不是门。这个 handler 在组件挂载期间一直可达（对话框、键盘、
    //    以及 React 把一个旧闭包留在手上的那些时刻），所以角色要在**发请求
    //    之前**在这里再问一遍 —— 仓库里另外七处确认写入都是这个形状。
    if (!writable) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/v1/enrollment-codes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        setError(labels.mintFailed);
        return;
      }
      const body = (await response.json()) as { code?: string; expires_at?: number };
      if (!body.code) {
        // 🔴 没有码却当成成功，是这个界面能犯的最坏的错：运维会去启动一台
        //    机器，而那台机器等一个不存在的凭据。
        setError(labels.mintFailed);
        return;
      }
      setCode(body.code);
      setExpiresAt(typeof body.expires_at === "number" ? body.expires_at : null);
    } catch {
      setError(labels.mintFailed);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    // 同 `mint`：角色在发请求之前问，不靠按钮藏起来。
    if (!writable) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/v1/device-certificates/${id}/revoke`, { method: "POST" });
      if (!response.ok) {
        setError(labels.revokeFailed);
        return;
      }
      setConfirming(null);
      router.refresh();
    } catch {
      setError(labels.revokeFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <FormHint>{labels.intro}</FormHint>

      {/* 0 的时候什么都不说：一行「还有 0 个」是噪音。 */}
      {outstanding > 0 ? (
        <FormHint>{interpolate(labels.outstanding, { count: String(outstanding) })}</FormHint>
      ) : null}

      {writable ? (
        <ButtonRow>
          <Button type="button" onClick={mint} disabled={busy}>
            {busy ? labels.minting : labels.mint}
          </Button>
        </ButtonRow>
      ) : null}

      {error ? <FormError>{error}</FormError> : null}

      {/* 🔴 码显示在这里，**只此一次**。上面那段注释说了为什么不提供「再看
          一次」；这里的文案必须把这件事说在运维还看得见码的时候。 */}
      {code ? (
        <div className="flex flex-col gap-1 rounded border border-solid border-warn bg-warn-wash p-3">
          <span className="text-sm font-semibold">{labels.codeOnce}</span>
          <code className="break-all font-mono text-base">{code}</code>
          {expiresAt ? (
            <span className="text-xs text-muted-foreground">
              {labels.codeExpires}
              {new Date(expiresAt).toISOString().replace("T", " ").slice(0, 19)}
            </span>
          ) : null}
          <span className="text-xs text-muted-foreground">{labels.codeHow}</span>
        </div>
      ) : null}

      {certificates.length === 0 ? (
        <FormHint>{labels.noCertificates}</FormHint>
      ) : (
        <Table>
          <TableHeader>
            <TableRow head>
              <TableHead>{labels.colDevice}</TableHead>
              <TableHead secondary>{labels.colFingerprint}</TableHead>
              <TableHead>{labels.colExpires}</TableHead>
              <TableHead>{labels.colState}</TableHead>
              {writable ? <TableHead label={labels.colActions} /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {certificates.map((certificate) => (
              <TableRow key={certificate.id}>
                <TableCell mono>{certificate.deviceId}</TableCell>
                {/* 指纹 64 个十六进制字符，全画会把这一行挤爆。显示尾段，
                    完整值放 title —— 网关查吊销用的就是这个键，所以运维
                    偶尔需要拿到它。 */}
                <TableCell mono faint secondary title={certificate.fingerprint}>
                  …{certificate.fingerprint.slice(-12)}
                </TableCell>
                <TableCell mono faint>
                  {new Date(certificate.notAfter).toISOString().slice(0, 10)}
                </TableCell>
                <TableCell>
                  {certificate.revokedAt === null ? (
                    <Badge tone="ok">{labels.stateActive}</Badge>
                  ) : (
                    // 吊销的时刻放 title：它是「这台机器什么时候不再可信」的
                    // 唯一记录，而网关侧的吊销是幂等的，所以它不会被后来的
                    // 重复点击改写。
                    <Badge
                      tone="bad"
                      title={new Date(certificate.revokedAt).toISOString().replace("T", " ").slice(0, 19)}
                    >
                      {labels.stateRevoked}
                    </Badge>
                  )}
                </TableCell>
                {writable ? (
                  <TableCell>
                    {certificate.revokedAt !== null ? null : (
                      <Button
                        type="button"
                        variant="risk"
                        onClick={() => setConfirming(certificate.id)}
                        disabled={busy}
                      >
                        {labels.revoke}
                      </Button>
                    )}
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {/* ⚠️ 用仓库已有的 `ConfirmDialog`，不是我原来手搓的那个内联两段式。
          它带来的三件事我自己写不出来：焦点陷阱、Escape/点遮罩取消，以及
          **打开时焦点落在「取消」上** —— 危险按钮拿到焦点的话，一次误按回车
          就等于吊销了一张证书。`assertConsequence` 还会在渲染时拦下一句
          「确定吗？」冒充后果。

          **条件挂载 + `open` 常真**，照仓库十一处调用点里那十处的形状写。
          这样卸载由 React 决定，不依赖退场动画跑完。

          ⚠️ 这里本来写着一段「不这么写会整页卡死」的结论，那个结论是**错的**，
             留一句在这儿免得下一个人（或者我）再走一遍：我在预览面板里观察到
             按取消之后节点留在 DOM、`body` 还锁着 `overflow:hidden`，于是判定
             Radix 的 Presence 在等一个不会到的 `animationend`。

             真正的原因是那个面板隐藏时**帧时钟是停的** —— 一个单独的
             `await requestAnimationFrame` 会直接超时 45 秒，而 `setTimeout`
             轮询照常跑。CSS 动画走同一个时钟，所以退场永远走不完。面板一露出来
             （截一张图就够）节点立刻消失、`overflow` 恢复。真实浏览器里没有
             这个问题，`send-sms.tsx` 那个 `open={pending !== null}` 也没有缺陷。 */}
      {confirming !== null ? (
        <ConfirmDialog
          open
          title={labels.revoke}
          consequence={labels.revokeWarning}
          labels={{
            // 「确定继续？」和「取消」用全站共享的那两句（`confirm.*`），不是
            // 我自己再造一对 —— 十一处调用点都用它们。
            question: labels.confirmQuestion,
            proceed: labels.revokeConfirm,
            cancel: labels.confirmCancel,
          }}
          busy={busy}
          onConfirm={() => revoke(confirming)}
          onCancel={() => setConfirming(null)}
        />
      ) : null}
    </div>
  );
}
