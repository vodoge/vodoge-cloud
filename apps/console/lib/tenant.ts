export type TenantRegion = "cn" | "intl";

export type Tenant = {
  tenant_id: string;
  slug: string;
  region: TenantRegion;
  status: string;
};

export type TenantLookup = (slug: string) => Promise<Tenant | null>;

export const TENANT_HEADER = {
  id: "x-vodoge-tenant-id",
  slug: "x-vodoge-slug",
  region: "x-vodoge-region",
  status: "x-vodoge-status",
  pathname: "x-vodoge-pathname",
} as const;

const DEFAULT_GATEWAY_URL = "http://127.0.0.1:18080";

export function isTenantRegion(value: string): value is TenantRegion {
  return value === "cn" || value === "intl";
}

export function parseTenant(body: unknown): Tenant | null {
  if (!body || typeof body !== "object") {
    return null;
  }
  const record = body as Record<string, unknown>;
  const tenant_id = record.tenant_id;
  const slug = record.slug;
  const region = record.region;
  const status = record.status;
  if (typeof tenant_id !== "string" || tenant_id.length === 0) {
    return null;
  }
  if (typeof slug !== "string" || slug.length === 0) {
    return null;
  }
  if (typeof region !== "string" || !isTenantRegion(region)) {
    return null;
  }
  if (typeof status !== "string" || status.length === 0) {
    return null;
  }
  return {
    tenant_id,
    slug: slug.toLowerCase(),
    region,
    status,
  };
}

/** In-process slug → tenant cache. Region cannot be overwritten. */
export class TenantCache {
  private readonly entries = new Map<string, Tenant>();

  lookup(slug: string): Tenant | undefined {
    return this.entries.get(slug);
  }

  store(tenant: Tenant): boolean {
    const existing = this.entries.get(tenant.slug);
    if (existing && existing.region !== tenant.region) {
      return false;
    }
    this.entries.set(tenant.slug, tenant);
    return true;
  }

  get size(): number {
    return this.entries.size;
  }
}

export class TenantDirectory {
  readonly cache: TenantCache;
  private readonly lookup: TenantLookup;

  constructor(lookup: TenantLookup, cache: TenantCache = new TenantCache()) {
    this.lookup = lookup;
    this.cache = cache;
  }

  async resolve(slug: string): Promise<Tenant | null> {
    const key = slug.trim().toLowerCase();
    if (!key) {
      return null;
    }
    const cached = this.cache.lookup(key);
    if (cached) {
      return cached;
    }
    const tenant = await this.lookup(key);
    if (!tenant) {
      return null;
    }
    if (tenant.slug !== key) {
      return null;
    }
    this.cache.store(tenant);
    return this.cache.lookup(key) ?? tenant;
  }
}

export function createGatewayLookup(options: {
  baseUrl: string;
  fetch?: typeof fetch;
}): TenantLookup {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? fetch;
  return async (slug: string) => {
    const url = `${baseUrl}/v1/tenants/${encodeURIComponent(slug)}`;
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`tenant lookup failed: ${response.status}`);
    }
    const body: unknown = await response.json();
    const tenant = parseTenant(body);
    if (!tenant) {
      throw new Error("tenant lookup returned an invalid body");
    }
    return tenant;
  };
}

let shared: TenantDirectory | undefined;

export function gatewayBaseUrl(): string {
  return process.env.VODOGE_GATEWAY_URL?.trim() || DEFAULT_GATEWAY_URL;
}

export function getSharedDirectory(): TenantDirectory {
  if (!shared) {
    shared = new TenantDirectory(createGatewayLookup({ baseUrl: gatewayBaseUrl() }));
  }
  return shared;
}

export function resetSharedDirectory(): void {
  shared = undefined;
}
