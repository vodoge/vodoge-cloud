/**
 * Console session cookie.
 *
 * The gateway is the only thing that decides whether a session is valid; the
 * console just carries the token. Keeping the token in an httpOnly cookie means
 * page scripts cannot read it, so an injected script cannot walk off with a
 * live session.
 */

export const SESSION_COOKIE = "vodoge_session";

/** Paths reachable without a session. */
const PUBLIC_PATHS = ["/login", "/unknown-tenant", "/not-a-tenant"];

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
