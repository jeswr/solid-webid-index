// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // App Router with nodejs runtime for all routes that need Node APIs
  // (DNS pinning, undici Agent) — documented in docs/DESIGN.md §5 / §4.
  // Never switch to the edge runtime: guardedFetch requires node:dns.lookup
  // and undici Agent dispatchers, which are absent on the edge.

  // @neondatabase/serverless uses a shorthand package.json exports map that
  // webpack 5 cannot resolve (it expects a "." key; the package only has
  // {require, import} at the top level).  Mark it as a server-external so
  // Next.js bundles it via require() rather than webpack module resolution.
  serverExternalPackages: ["@neondatabase/serverless"],

  // Advertise EXACTLY ONE `ldp:inbox` Link on the ROOT `/` (DESIGN.md §4.3 / sw H2) — the global
  // suggest inbox is discoverable from `/`, NOT from individual entries (`/p/{slug}`), which would
  // misuse `ldp:inbox` to mean "notifications about this person". The Link header is the discovery
  // surface; a future DCAT `GET /` RDF route may additionally emit the triple in-body (additive).
  async headers() {
    const origin = (
      process.env.INDEX_BASE_URL ??
      (process.env.VERCEL_URL
        ? `https://${process.env.VERCEL_URL}`
        : "http://localhost:3000")
    ).replace(/\/+$/, "");
    return [
      {
        source: "/",
        headers: [
          {
            key: "Link",
            value: `<${origin}/inbox/>; rel="http://www.w3.org/ns/ldp#inbox"`,
          },
        ],
      },
    ];
  },
};

export default nextConfig;
