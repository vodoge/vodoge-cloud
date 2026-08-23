/**
 * Console session cookie.
 *
 * The gateway is the only thing that decides whether a session is valid; the
 * console just carries the token. Keeping the token in an httpOnly cookie means
 * page scripts cannot read it, so an injected script cannot walk off with a
 * live session.
 */

export const SESSION_COOKIE = "vodoge_session";

/**
 * Paths reachable without a session.
 *
 * The sign-in endpoint has to be here: gating it sends the login request itself
 * to the login page, and there is then no way to ever obtain a session. Sign-out
 * is here for the same reason — it must work when the session is already gone.
 */
const PUBLIC_PATHS = [
  "/login",
  "/api/auth/login",
  "/api/auth/logout",
  "/unknown-tenant",
  "/not-a-tenant",
];

export type CookieAttributes = {
  name: string;
  value: string;
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  maxAge?: number;
  expires?: Date;
};

/**
 * Whether a path may be served without a session.
 *
 * Matching on a prefix would let `/loginsomething` through, so each entry has
 * to be the whole segment.
 */
export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (allowed) => pathname === allowed || pathname.startsWith(`${allowed}/`),
  );
}

/**
 * Cookie for a freshly issued token.
 *
 * `secure` is on unless the console is being served over plain HTTP, which only
 * happens in local development; a cookie marked secure is simply not sent back
 * over http:// and the session would appear to fail silently.
 */
export function sessionCookie(
  token: string,
  expiresAt: Date,
  { secure }: { secure: boolean },
): CookieAttributes {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    expires: expiresAt,
  };
}

/** Cookie that removes the session. */
export function clearedSessionCookie({ secure }: { secure: boolean }): CookieAttributes {
  return {
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: 0,
  };
}

/** Authorization header for a token, or nothing when there is no session. */
export function bearerHeader(token: string | undefined): Record<string, string> {
  const trimmed = token?.trim();
  return trimmed ? { authorization: `Bearer ${trimmed}` } : {};
}

/**
 * The Authorization header a proxied gateway call needs, if any.
 *
 * The session cookie is httpOnly, so a browser calling /v1/* cannot present it
 * as the bearer credential the gateway requires — every such request was
 * answered 401, which is why the console could render data fetched on the
 * server but could not perform a single action from the page. The middleware
 * attaches it on the way through, which keeps the token out of client
 * JavaScript.
 *
 * Only gateway paths get it. A token on a request to a console page would be
 * pointless, and widening the rule is how a credential ends up somewhere
 * nobody expected it.
 */
export function gatewayAuthHeader(
  pathname: string,
  token: string | undefined,
): Record<string, string> {
  if (!pathname.startsWith(`${GATEWAY_PREFIX}/`)) {
    return {};
  }
  return bearerHeader(token);
}

const GATEWAY_PREFIX = "/v1";

/**
 * Where to send someone who needs to sign in first.
 *
 * The destination is kept so they land where they were headed, but only when it
 * is a path on this site: an absolute URL here would turn the login page into
 * an open redirect.
 */
export function loginRedirect(pathname: string): string {
  const safe = pathname.startsWith("/") && !pathname.startsWith("//") ? pathname : "/";
  if (safe === "/" || isPublicPath(safe)) {
    return "/login";
  }
  return `/login?next=${encodeURIComponent(safe)}`;
}

/** Destination to use after a successful sign-in. */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//")) {
    return "/";
  }
  return next;
}

/**
 * What the signed-in account may do.
 *
 * The console renders by this. It does not enforce by it: the gateway refuses
 * every state-changing request from a read-only session at one chokepoint
 * around its whole route table, and /v1 is reachable with curl and a token
 * whatever this page decides to draw. Hiding a button an account cannot use is
 * courtesy, not a permission model, and the two must not be confused — the
 * previous shape of this feature was buttons alone.
 */
export type ConsoleRole = "admin" | "readonly";

/** Whether a role may change anything. */
export function mayWrite(role: ConsoleRole): boolean {
  return role === "admin";
}

/**
 * The role in a /v1/auth/session body.
 *
 * Anything unrecognised reads as read-only. A page that cannot tell what the
 * account is should draw the smaller of the two versions of itself: the cost
 * of being wrong that way is a missing button, and the cost of being wrong the
 * other way is an operator clicking something that then fails at the gateway
 * with a message they cannot act on.
 */
export function roleFromSessionBody(body: unknown): ConsoleRole {
  if (!body || typeof body !== "object") return "readonly";
  return (body as { role?: unknown }).role === "admin" ? "admin" : "readonly";
}

/** Where the role is read from, on the server and in the browser alike. */
export const SESSION_ENDPOINT = "/v1/auth/session";
