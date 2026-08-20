import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const gateway = process.env.VODOGE_GATEWAY_URL?.trim() || "http://127.0.0.1:18080";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  outputFileTracingRoot: path.dirname(fileURLToPath(import.meta.url)),
  async rewrites() {
    return [{ source: "/v1/:path*", destination: `${gateway}/v1/:path*` }];
  },
};

export default nextConfig;
