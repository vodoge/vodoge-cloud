export const DEFAULT_BASE_DOMAIN = "vodoge.com";
export const OPERATOR_SLUG = "a";
export const OPERATOR_TENANT_ID = "a0000000-0000-4000-8000-00000000000a";

export type HostClassification =
  | { kind: "apex"; host: string }
  | { kind: "tenant"; host: string; slug: string }
  | { kind: "unknown"; host: string };

export type TenantRouteDecision = "apex" | "not-found" | "tenant";

type HeaderReader = { get(name: string): string | null };

function stripPort(host: string): string {
  const trimmed = host.trim();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end !== -1) {
      return trimmed.slice(1, end);
    }
  }
  const colon = trimmed.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(trimmed.slice(colon + 1))) {
    return trimmed.slice(0, colon);
  }
  return trimmed;
}

function normalizeBaseDomain(baseDomain: string | undefined): string {
  const base = (baseDomain ?? "").trim().toLowerCase();
  return base || DEFAULT_BASE_DOMAIN;
}

/**
 * Whether this deployment sits behind a proxy that rewrites `Host`.
 *
 * 🔴 默认 **false**。`X-Forwarded-Host` 是客户端可以随便写的，信任它就等于
 * 让任何能直连这个进程的东西自己挑租户。
 *
 * 2026-09-05 在生产上实测过这条：从 `trek_default` 上任意一个容器直连
 * `http://vodoge-cloud-console-1:3000/login`，带
 * `Host: vodoge.com` + `X-Forwarded-Host: a.vodoge.com`，拿到的是租户 a 的
 * 页面（15579 字节，与真实 `a.vodoge.com` 同长）；不带那个头拿到的是 apex
 * 页面（13840 字节）。**邻居容器可以伪造租户。**
 *
 * 经 Caddy 是安全的 —— 同一次实测里，伪造与不伪造的响应逐字节相同，
 * 说明 Caddy 用真实 Host 覆盖了它。但 console 同时挂在 `backend`、`edge`、
 * `ingress`(=`trek_default`) 三个网络上，而 `trek_default` 上跑着
 * trek / anki / rustdesk 三个第三方镜像。
 *
 * 这个偏好本来是为「上游把 Host 改写成了 IP」的部署加的（旧测试里那个
 * `host: 127.0.0.1:18080` 就是它）。**这套部署不是那样的** —— Caddy 原样
 * 传递 Host，所以这条路径用不到它。于是它从默认变成显式开启：需要的人写
 * `VODOGE_TRUST_FORWARDED_HOST=1`，而写下它的人得自己保证那个进程只能被
 * 可信代理够到。
 */
export function trustsForwardedHost(value: string | undefined): boolean {
  return (value ?? "").trim() === "1";
}

export interface HostOptions {
  /** 见 `trustsForwardedHost`。默认 false。 */
  trustForwarded?: boolean;
}

/**
 * Host used for tenant routing.
 *
 * ⚠️ 只有在 `trustForwarded` 为真时才看 `X-Forwarded-Host`。理由见
 * `trustsForwardedHost`。
 */
export function requestHost(headers: HeaderReader, options: HostOptions = {}): string {
  if (options.trustForwarded) {
    const forwarded = headers.get("x-forwarded-host") ?? headers.get("X-Forwarded-Host");
    if (forwarded) {
      return forwarded.split(",")[0]?.trim() ?? "";
    }
  }
  return (headers.get("host") ?? headers.get("Host") ?? "").trim();
}

/**
 * Extracts the single-label tenant subdomain.
 *
 *   a.vodoge.com       → "a", true
 *   vodoge.com         → "", false  (apex is not a tenant)
 *   www.vodoge.com     → "", false
 *   foo.bar.vodoge.com → "", false
 */
export function slugFromHost(
  host: string,
  baseDomain: string = DEFAULT_BASE_DOMAIN,
): { slug: string; ok: true } | { slug: ""; ok: false } {
  const normalized = stripPort(host).toLowerCase();
  if (!normalized) {
    return { slug: "", ok: false };
  }
  const base = normalizeBaseDomain(baseDomain);
  if (normalized === base || normalized === `www.${base}`) {
    return { slug: "", ok: false };
  }
  const suffix = `.${base}`;
  if (!normalized.endsWith(suffix)) {
    return { slug: "", ok: false };
  }
  const slug = normalized.slice(0, -suffix.length);
  if (!slug || slug.includes(".")) {
    return { slug: "", ok: false };
  }
  return { slug, ok: true };
}

export function classifyHost(
  host: string,
  baseDomain: string = DEFAULT_BASE_DOMAIN,
): HostClassification {
  const normalized = stripPort(host).toLowerCase();
  const base = normalizeBaseDomain(baseDomain);
  if (!normalized) {
    return { kind: "unknown", host: normalized };
  }
  if (normalized === base || normalized === `www.${base}`) {
    return { kind: "apex", host: normalized };
  }
  const extracted = slugFromHost(normalized, base);
  if (!extracted.ok) {
    return { kind: "unknown", host: normalized };
  }
  return { kind: "tenant", host: normalized, slug: extracted.slug };
}

/**
 * Unknown slugs 404. A lookup result for a different slug (including operator
 * tenant `a`) is never used as a default.
 */
export function decideTenantRoute(
  classification: HostClassification,
  tenant: { slug: string } | null,
): TenantRouteDecision {
  if (classification.kind === "apex") {
    return "apex";
  }
  if (classification.kind !== "tenant") {
    return "not-found";
  }
  if (!tenant || tenant.slug !== classification.slug) {
    return "not-found";
  }
  return "tenant";
}

/**
 * 网关用来认「这是哪个调用方」的头，由控制台转述。
 *
 * 🔴 存在的理由是限流：控制台把每一个 `/v1/*` 转发给网关（next.config.ts 里
 * 那条 rewrite），登录还多走一层 `POST /api/auth/login` 里的服务端 fetch。
 * 于是网关看到的对端**永远**是 console 容器那一个地址，按地址限流就变成了
 * 全平台共用一个桶：任何人打五次废凭据，之后每个租户的每位运维都登不进去。
 *
 * 网关只在对端属于 `VODOGE_TRUSTED_PROXIES` 时才认这个头。
 */
export const CLIENT_ADDRESS_HEADER = "x-vodoge-client-address";

/**
 * 真实调用方地址。
 *
 * 🔴 这条链是**量出来的**，不是推的（2026-09-18，读 Caddy 的访问日志）：
 *
 *     客户端 → Cloudflare → Caddy → console → 网关
 *
 * 仓库里在此之前任何地方都没写过 Cloudflare 这一跳。它改变了取值方式：
 *
 *   - Cloudflare 送给 Caddy 的是 `cf-connecting-ip: <真实客户端>`，同时
 *     `x-forwarded-for` 里**只有**那一个地址；
 *   - Caddy 再把自己的对端（Cloudflare 那个边缘节点）追加到 XFF 末尾。
 *
 * 所以「取 XFF 最后一段」拿到的是 **Cloudflare 边缘节点**，而它每个请求都
 * 不一样 —— 实测并发 12 次登录只有 1 次被限流，因为那 12 个请求分别记在了
 * 12 个不同边缘节点的桶里。按那个值限流等于没有限流。
 *
 * ⚠️ 于是优先认 `cf-connecting-ip`，没有它才退回 XFF 的最后一段（没有
 *    Cloudflare 的部署里，那一段就是 Caddy 的对端，也就是真实客户端）。
 *
 * 🔴 拿不到就返回 null，**不**编一个。编出来的地址会让一群互不相干的调用方
 *    挤进同一个桶，而那正是这件事要修的毛病。缺席 ≠ 空。
 *
 * ⚠️ 绕过 Cloudflare 直连源站（源站 IP 是公开的）的请求可以自己写
 *    `cf-connecting-ip`，从而挑一个桶。真正堵死它要么在防火墙上只放
 *    Cloudflare 的网段进来，要么在 Caddy 上配 `trusted_proxies` —— 两者都在
 *    这个仓库之外（Caddyfile 属于 trek 那套）。这里记下来，不假装它不存在。
 */
export function forwardedClientAddress(headers: HeaderReader): string | null {
  const cloudflare = headers.get("cf-connecting-ip");
  const direct = normaliseAddress(cloudflare);
  if (direct) {
    return direct;
  }
  const chain = headers.get("x-forwarded-for");
  if (!chain) {
    return null;
  }
  return normaliseAddress(chain.split(",").pop());
}

/** 去掉空白和端口；拿不出东西就是 null，不是空串。 */
function normaliseAddress(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  if (trimmed === "") {
    return null;
  }
  const stripped = stripPort(trimmed);
  return stripped === "" ? null : stripped;
}
