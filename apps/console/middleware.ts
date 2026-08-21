import { NextResponse, type NextRequest } from "next/server";
import {
  DEFAULT_BASE_DOMAIN,
  classifyHost,
  decideTenantRoute,
  requestHost,
} from "./lib/host";
import { isPublicPath, loginRedirect, SESSION_COOKIE } from "./lib/session";
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

  // The gateway is what decides whether a session is valid. This only keeps a
  // signed-out visitor from loading a page that would fail every request on it,
  // so a missing cookie is a redirect rather than a decision about access.
  const pathname = request.nextUrl.pathname;
  if (!isPublicPath(pathname) && !request.cookies.get(SESSION_COOKIE)?.value) {
    const url = request.nextUrl.clone();
    const target = loginRedirect(pathname);
    const [path, query] = target.split("?");
    url.pathname = path ?? "/login";
    url.search = query ? `?${query}` : "";
    return NextResponse.redirect(url);
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
  // PWA assets are excluded, not merely made public. The browser fetches the
  // manifest and service worker outside any page context, so gating them sends
  // a redirect where a file is expected; the offline page in particular has to
  // work when there is no session and no network. Skipping them here also
  // avoids a tenant lookup — a gateway round trip — for every static asset.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|offline.html|icon.svg|icon-maskable.svg).*)",
  ],
};
