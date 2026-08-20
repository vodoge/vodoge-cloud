import { NextResponse, type NextRequest } from "next/server";
import {
  DEFAULT_BASE_DOMAIN,
  classifyHost,
  decideTenantRoute,
  requestHost,
} from "./lib/host";
import { TENANT_HEADER, getSharedDirectory } from "./lib/tenant";

export async function middleware(request: NextRequest) {
  const host = requestHost(request.headers);
  const baseDomain = process.env.VODOGE_BASE_DOMAIN?.trim() || DEFAULT_BASE_DOMAIN;
  const classification = classifyHost(host, baseDomain);

  if (classification.kind === "apex") {
    const url = request.nextUrl.clone();
    url.pathname = "/not-a-tenant";
    return NextResponse.rewrite(url);
  }

  if (classification.kind !== "tenant") {
    return rewriteUnknown(request);
  }

  let tenant;
  try {
    tenant = await getSharedDirectory().resolve(classification.slug);
  } catch {
    return new NextResponse("tenant lookup failed", {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  if (decideTenantRoute(classification, tenant) !== "tenant" || !tenant) {
    return rewriteUnknown(request);
  }

  const headers = new Headers(request.headers);
  headers.set(TENANT_HEADER.id, tenant.tenant_id);
  headers.set(TENANT_HEADER.slug, tenant.slug);
  headers.set(TENANT_HEADER.region, tenant.region);
  headers.set(TENANT_HEADER.status, tenant.status);
  headers.set(TENANT_HEADER.pathname, request.nextUrl.pathname);
  return NextResponse.next({ request: { headers } });
}

function rewriteUnknown(request: NextRequest) {
  const url = request.nextUrl.clone();
  url.pathname = "/unknown-tenant";
  return NextResponse.rewrite(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
