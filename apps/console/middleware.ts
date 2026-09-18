import { NextResponse, type NextRequest } from "next/server";
import {
  CLIENT_ADDRESS_HEADER,
  DEFAULT_BASE_DOMAIN,
  classifyHost,
  decideTenantRoute,
  forwardedClientAddress,
  requestHost,
  trustsForwardedHost,
} from "./lib/host";
import {
  gatewayAuthHeader,
  isPublicPath,
  loginRedirect,
  SESSION_COOKIE,
} from "./lib/session";
import { TENANT_HEADER, getSharedDirectory } from "./lib/tenant";

export async function middleware(request: NextRequest) {
  const host = requestHost(request.headers, {
    trustForwarded: trustsForwardedHost(process.env.VODOGE_TRUST_FORWARDED_HOST),
  });
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
  // 谁在敲门。网关的登录限流按这个值分桶 —— 没有它，每一次登录都记在
  // console 容器那一个桶里，于是一个人五次废凭据就能把所有人挡在外面。
  //
  // 🔴 先删再设。这个头是调用方可以自己带的，而带着它进来的那一个正是想自己
  //    挑桶的那一个。推不出地址时就让它**不存在** —— 不是留着对方写的那个值，
  //    也不是编一个。
  headers.delete(CLIENT_ADDRESS_HEADER);
  const client = forwardedClientAddress(request.headers);
  if (client) {
    headers.set(CLIENT_ADDRESS_HEADER, client);
  }
  for (const [name, value] of Object.entries(
    gatewayAuthHeader(request.nextUrl.pathname, request.cookies.get(SESSION_COOKIE)?.value),
  )) {
    headers.set(name, value);
  }
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
  // Static assets are excluded, not merely made public. The browser fetches the
  // manifest, the icons and the service worker outside any page context, so
  // gating them sends a redirect where a file is expected; the offline page in
  // particular has to work when there is no session and no network. Skipping
  // them here also avoids a tenant lookup — a gateway round trip — for every
  // static asset, which is why `lib/session.ts`'s PUBLIC_PATHS is the wrong
  // place for this even though it looks like the obvious one.
  //
  // This used to be a list of filenames, and the list was the bug: it named the
  // five files that existed the day it was written, and the seven PNGs added
  // later were answered `307 → /login` in production for anyone without a
  // session. Nothing failed — the icons simply arrived as a login page — so the
  // manifest looked correct while no browser could install the console.
  //
  // The rule now describes the *shape* of a static asset instead: one path
  // segment with a dot in it, which is exactly how everything in `public/` is
  // served. Nobody has to remember to add the next file. It is anchored to a
  // single segment on purpose — `/devices/anything.png` still reaches this
  // middleware, and so does every `/api/…` and `/v1/…`, because those have two
  // segments or more. `lib/pwa.ts` carries the reasoning and the same string as
  // a testable value; `lib/pwa.test.ts` reconciles this literal against the
  // real contents of `public/` and against every route under `app/`, in both
  // directions, so neither an unreachable asset nor an unguarded page can be
  // introduced quietly again.
  matcher: ["/((?!_next/|[^/]+\\.[A-Za-z0-9]+$).*)"],
};
