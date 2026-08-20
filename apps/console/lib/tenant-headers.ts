import { headers } from "next/headers";
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
  const requestHeaders = await headers();
  const forwarded = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("X-Forwarded-Host");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() ?? "";
  }
  return requestHeaders.get("host") ?? "";
}
