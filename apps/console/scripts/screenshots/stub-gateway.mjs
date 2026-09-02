/**
 * 拍安装截图用的桩网关，兼反向代理。
 *
 * 🔴 **为什么需要它，而不是直接开 `next start` 然后截图。**
 *
 * 这个控制台的租户**不是从 host 解析的**，是网关注入的四个请求头
 * （`x-vodoge-tenant-id` / `-slug` / `-region` / `-status`，见 `lib/tenant.ts`
 * 的 `TENANT_HEADER`），会话则是 `vodoge_session` cookie。直连 Next 只会拿到
 * 登录页——`app/layout.tsx` 的 `tenant && signedIn` 两个条件都不成立。
 *
 * 真网关要 PostgreSQL、Redis 和 mTLS 上行。截图只需要「这棵树渲染出来的画面」，
 * 所以这里只做两件事：应答 `/v1/*` 的几个只读端点，把其余请求转给
 * `127.0.0.1:3000` 并补上那四个头和 cookie。
 *
 * ⚠️ **数据是照着截图里那一版复刻的**：11/12 在线、30 条短信、10 个去重对端，
 * 以及那八条按时间倒序的消息。改了它，新旧两版截图就不再可比，而「这次改动在
 * 画面里看不看得见」这个判断会连带失去参照。
 *
 * ⚠️ **`received_at` 必须是数字（epoch 毫秒）**。`lib/catalog.ts` 的
 * `parseMessage` 用 `asNumber` 读它，给 ISO 字符串会让整行被静默丢弃，页面上
 * 短信总量显示 0 而没有任何报错——写这个桩时先踩了一次。
 *
 * 用法见 `scripts/screenshots/capture.mjs` 的头部；它会假定这个进程已经在
 * 8788 上听着。
 */
import { createServer } from "node:http";
import { request as httpRequest } from "node:http";

const GATEWAY_PORT = 8788;
const CONSOLE_PORT = 3000;

/** 租户来自网关，不是 host。slug 要和下面转发时写的 host 对得上。 */
const TENANT = {
  tenant_id: "11111111-1111-4111-8111-111111111111",
  slug: "a",
  region: "cn",
  status: "active",
};

const BODIES = [
  ["+8613800000001", "设备已恢复上报，队列已清空。", "sms", "2026-08-27T08:58:00Z"],
  ["+8613800000002", "网络已切换至备用 APN。", "ims", "2026-08-27T08:56:00Z"],
  ["+8613800000003", "本月流量已使用 78%。", "sms", "2026-08-27T08:53:00Z"],
  ["+8613800000004", "DEMO-07 超过 45 分钟未上报。", "sms", "2026-08-27T08:49:00Z"],
  ["+8613800000005", "固件 0.9.4 安装完成，等待重启。", "ims", "2026-08-27T08:42:00Z"],
  ["+8613800000006", "信号低于阈值 -105 dBm。", "sms", "2026-08-27T08:34:00Z"],
  ["+8613800000007", "eSIM 配置文件将于 30 天后到期。", "sms", "2026-08-27T08:27:00Z"],
  ["+8613800000008", "代理出口 IP 已更换。", "sms", "2026-08-27T08:19:00Z"],
];

const SHOWN = BODIES.map(([peer, body, bearer, at], i) => ({
  id: `m${i + 1}`,
  device_id: "d1",
  direction: "inbound",
  peer,
  body,
  bearer,
  received_at: Date.parse(at),
  seq: i + 1,
}));

/** 首页只画前八条，其余只是把总量凑到 30——那个数字在统计卡上。 */
const FILLER = Array.from({ length: 22 }, (_, i) => ({
  id: `f${i}`,
  device_id: "d1",
  direction: "inbound",
  peer: `+861390000${String(i).padStart(4, "0")}`,
  body: "…",
  bearer: "sms",
  received_at: Date.parse(`2026-08-27T0${i % 8}:00:00Z`),
  seq: 100 + i,
}));

/** 12 台里 11 台在线，和统计卡上的「11 / 共 12 台已接入」对应。 */
const DEVICES = Array.from({ length: 12 }, (_, i) => ({
  id: `d${i + 1}`,
  name: `DEMO-${String(i + 1).padStart(2, "0")}`,
  state: i === 11 ? "offline" : "online",
  last_seen: "2026-08-27T08:58:00Z",
  edge_version: "0.9.4",
}));

const SESSIONS = Array.from({ length: 10 }, (_, i) => ({
  peer: `+861380000000${i + 1}`,
  device_id: "d1",
  count: 3,
  last_body: "…",
  last_received_at: Date.parse("2026-08-27T08:58:00Z"),
}));

const ROUTES = {
  "/v1/devices": { devices: DEVICES },
  "/v1/messages": { messages: [...SHOWN, ...FILLER] },
  "/v1/sessions": { sessions: SESSIONS },
};

createServer((incoming, response) => {
  const path = (incoming.url ?? "").split("?")[0];

  if (path.startsWith("/v1/")) {
    const body = path.startsWith("/v1/tenants/") ? TENANT : ROUTES[path];
    response.writeHead(body ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(body ?? { error: "not found" }));
    return;
  }

  const upstream = httpRequest(
    {
      host: "127.0.0.1",
      port: CONSOLE_PORT,
      path: incoming.url,
      method: incoming.method,
      headers: {
        ...incoming.headers,
        // `middleware.ts` 用 host 算 slug，再回头问这个网关要租户。
        host: `${TENANT.slug}.vodoge.com`,
        "x-forwarded-host": `${TENANT.slug}.vodoge.com`,
        cookie: [incoming.headers.cookie, "vodoge_session=screenshot"]
          .filter(Boolean)
          .join("; "),
      },
    },
    (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    },
  );
  upstream.on("error", (error) => {
    response.writeHead(502, { "content-type": "text/plain" });
    response.end(String(error));
  });
  incoming.pipe(upstream);
}).listen(GATEWAY_PORT, "127.0.0.1", () => {
  console.log(`stub gateway + proxy on http://127.0.0.1:${GATEWAY_PORT}`);
  console.log(`  forwarding to the console on :${CONSOLE_PORT} as tenant "${TENANT.slug}"`);
});
