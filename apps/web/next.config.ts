import type { NextConfig } from "next";

const API = process.env.API_INTERNAL_URL ?? "http://localhost:1061";

const nextConfig: NextConfig = {
  transpilePackages: ["@orbix/ui"],
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API}/:path*` }];
  },
};

export default nextConfig;
