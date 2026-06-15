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
};

export default nextConfig;
