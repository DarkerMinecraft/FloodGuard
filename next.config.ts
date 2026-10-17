import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server (.next/standalone) for the container image (Dockerfile).
  output: "standalone",
  experimental: {
    agentFeedback: true,
  },
  cacheComponents: true,
  // Load the Azure SDKs with plain Node require: @azure/identity pulls in `open`,
  // which references powershell.exe by absolute path and breaks bundling.
  // exifr probes for fs/zlib when bundled and logs warnings; plain require avoids that.
  serverExternalPackages: ["@azure/identity", "@azure/storage-blob", "exifr"],
  partialPrefetching: true,
  async headers() {
    return [
      {
        // Browsers must always re-check the service worker so updates roll out promptly.
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
