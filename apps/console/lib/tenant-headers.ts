import { cookies, headers } from "next/headers";
import { requestHost as hostFromHeaders, trustsForwardedHost } from "./host";
import { SESSION_COOKIE } from "./session";
import { TENANT_HEADER, isTenantRegion, type Tenant } from "./tenant";

export { TENANT_HEADER };

export async function getTenantFromHeaders(): Promise<Tenant | null> {
  const requestHeaders = await headers();
  const tenant_id = requestHeaders.get(TENANT_HEADER.id);
  const slug = requestHeaders.get(TENANT_HEADER.slug);
  const region = requestHeaders.get(TENANT_HEADER.region);
  const status = requestHeaders.get(TENANT_HEADER.status);
  if (!tenant_id || !slug || !region || !isTenantRegion(region)) {
    return null;
  }
  return {
    tenant_id,
    slug,
    region,
    status: status || "unknown",
  };
}

export async function requestHost(): Promise<string> {
  // 🔴 委托给 lib/host 的那一个，不再抄第二遍。
  //
  // 这两处此前是同一段逻辑的两份拷贝 —— 于是「默认不信任 X-Forwarded-Host」
  // 这个改动必须记得改两个地方，而漏掉哪一个都不会有任何症状，
  // 直到有人从这条路进来。
  return hostFromHeaders(await headers(), {
    trustForwarded: trustsForwardedHost(process.env.VODOGE_TRUST_FORWARDED_HOST),
  });
}

/**
 * Session token for the current request.
 *
 * Read here rather than in the catalog client so the token is visible at every
 * call site, and so the client stays testable without a Next.js request scope.
 */
export async function sessionToken(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value;
}
