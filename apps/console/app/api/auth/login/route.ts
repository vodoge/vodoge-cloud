import { NextResponse, type NextRequest } from "next/server";
import { sessionCookie } from "@/lib/session";
import { gatewayBaseUrl } from "@/lib/tenant";

/**
 * Exchange a credential for a session cookie.
 *
 * The browser never sees the token: the console posts the credential to the
 * gateway, and the gateway's answer is stored in an httpOnly cookie. That keeps
 * the token out of reach of any script on the page.
 */
export async function POST(request: NextRequest) {
  const host = request.headers.get("host") ?? "";
  let payload: { email?: string; password?: string };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${gatewayBaseUrl()}/v1/auth/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-host": host,
      },
      body: JSON.stringify({ email: payload.email ?? "", password: payload.password ?? "" }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return NextResponse.json({ error: "sign-in is unavailable" }, { status: 502 });
  }

  if (!upstream.ok) {
    // The gateway answers the same way for a wrong password and an unknown
    // address; passing its status through keeps it that way.
    return NextResponse.json(
      { error: "email or password is incorrect" },
      { status: upstream.status === 401 ? 401 : 502 },
    );
  }

  const body = (await upstream.json()) as { token?: string; expires_at?: string };
  if (!body.token || !body.expires_at) {
    return NextResponse.json({ error: "sign-in is unavailable" }, { status: 502 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(
    sessionCookie(body.token, new Date(body.expires_at), {
      secure: request.nextUrl.protocol === "https:",
    }),
  );
  return response;
}
