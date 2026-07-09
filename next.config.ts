import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // node:sqlite is a Node builtin; keep server-only modules external.
  serverExternalPackages: [],
};

export default nextConfig;
