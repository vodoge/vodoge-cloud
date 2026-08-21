import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const gateway = process.env.VODOGE_GATEWAY_URL?.trim() || "http://127.0.0.1:18080";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // The console renders no images, and the optimiser pulls in sharp, whose
  // native binary is built for the machine that ran the build. Leaving it in
  // makes the standalone bundle unportable, and this project builds on a
  // workstation and runs on a small cloud host.
  images: { unoptimized: true },
  outputFileTracingRoot: path.dirname(fileURLToPath(import.meta.url)),
  async rewrites() {
    return [{ source: "/v1/:path*", destination: `${gateway}/v1/:path*` }];
  },
};

export default nextConfig;
