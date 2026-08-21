import { NextResponse, type NextRequest } from "next/server";
import { bearerHeader, clearedSessionCookie, SESSION_COOKIE } from "@/lib/session";
import { gatewayBaseUrl } from "@/lib/tenant";

/**
 * Drop the session here and at the gateway.
 *
 * Clearing only the cookie would leave the token valid until it expired, so a
 * copy taken beforehand would keep working.
 */
export async function POST(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (token) {
    try {
      await fetch(`${gatewayBaseUrl()}/v1/auth/logout`, {
        method: "POST",
        headers: {
          "x-forwarded-host": request.headers.get("host") ?? "",
          ...bearerHeader(token),
        },
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // The cookie still goes, so the browser is signed out either way.
    }
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(clearedSessionCookie({ secure: request.nextUrl.protocol === "https:" }));
  return response;
}
