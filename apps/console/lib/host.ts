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
 * Host used for tenant routing. Prefers the first X-Forwarded-Host label.
 */
export function requestHost(headers: HeaderReader): string {
  const forwarded = headers.get("x-forwarded-host") ?? headers.get("X-Forwarded-Host");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() ?? "";
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
