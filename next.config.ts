// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // App Router with nodejs runtime for all routes that need Node APIs
  // (DNS pinning, undici Agent) — documented in docs/DESIGN.md §5 / §4.
  // Never switch to the edge runtime: guardedFetch requires node:dns.lookup
  // and undici Agent dispatchers, which are absent on the edge.
};

export default nextConfig;
