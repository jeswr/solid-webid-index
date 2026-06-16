// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * lib/client — public entry point for the framework-agnostic WebID-index consumer
 * client (DESIGN.md §7). A consuming app (the Pod Manager, any suite app) imports
 * from here:
 *
 * ```ts
 * import { createIndexClient } from "solid-webid-index/client";
 *
 * const idx = createIndexClient({ origin: process.env.NEXT_PUBLIC_WEBID_INDEX ?? "" });
 * if (idx) {
 *   const page = await idx.search("alice");
 *   for (const e of page.entries) console.log(e.webid, e.name);
 *   if (page.next) await idx.fetchPage(page.next);
 *   await idx.suggestWebId("https://alice.pod/card#me", { actor: myWebId });
 * }
 * ```
 *
 * `createIndexClient` returns `null` when no origin is configured, so the whole
 * integration is gated on one env var.
 */

export { createIndexClient } from "./indexClient";
export type { IndexClient } from "./indexClient";
export type {
  IndexClientOptions,
  IndexEntry,
  IndexHealth,
  IndexPage,
  SearchOptions,
  SuggestOptions,
  SuggestOutcome,
} from "./types";
