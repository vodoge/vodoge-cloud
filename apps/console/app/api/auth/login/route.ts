import { NextResponse, type NextRequest } from "next/server";
import { CLIENT_ADDRESS_HEADER, forwardedClientAddress } from "@/lib/host";
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
        ...clientAddressHeader(request),
        // 🔴 这一条转发出去，网关的登录限流才分得清是谁在敲门。少了它，
        //    每一次登录都落在 console 容器那一个桶里：任何人五次废凭据打空
        //    桶之后，**所有租户的所有运维**都登不进去，一个 IP 每 12 秒补一下
        //    就能一直压着。这条路是生产上唯一到达 `/v1/auth/login` 的路。
        //
        //    ⚠️ 这里**自己**从 X-Forwarded-For 推，不读 middleware 设好的那
        //       一份：这条路上少一个环节就少一处要靠假设。（Next 的 rewrite
        //       把 middleware 改过的请求头转给上游 —— 那一条是实测过的，见
        //       lib/host.test.ts；而这一条根本用不到它。）
        //
        //    推不出来时**不发**这个头：网关那边会退回共用一个桶并且在日志里
        //    说出来，而不是拿一个编出来的地址去分桶。缺席 ≠ 空。
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

/** 调用方地址，转给网关；推不出来就不发。 */
function clientAddressHeader(request: NextRequest): Record<string, string> {
  const client = forwardedClientAddress(request.headers);
  return client ? { [CLIENT_ADDRESS_HEADER]: client } : {};
}
