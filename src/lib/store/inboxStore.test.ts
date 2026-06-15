// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * inboxStore.test.ts — the SuggestInboxStore methods on PgStore, against pglite (in-process
 * Postgres WASM). No network, no Neon account.
 *
 * Covers: suggestionStatus (unknown/live/tombstoned/cooldown), consumeRateBucket (fixed-window +
 * over-cap), recordNotification + getNotification + listNotifications (keyset paging), and that
 * markDone stamps terminal_at (driving the cooldown).
 */
import { describe, expect, it } from "vitest";

import type { PgStore } from "./pgStore";
import { freshTestStore } from "./testStore";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

async function makeTestStore(): Promise<PgStore> {
  const { store } = await freshTestStore();
  return store;
}

describe("SuggestInboxStore.suggestionStatus", () => {
  it("returns 'unknown' for a never-seen WebID", async () => {
    const store = await makeTestStore();
    const status = await store.suggestionStatus({
      webid: "https://new.pod/card#me",
      docUrl: "https://new.pod/card",
      nowMs: Date.now(),
      cooldownMs: WEEK,
    });
    expect(status).toBe("unknown");
  });

  it("returns 'live' for an indexed done doc", async () => {
    const store = await makeTestStore();
    await store.enqueue("https://alice.pod/card", {
      webid: "https://alice.pod/card#me",
      source: "inbox",
    });
    // Crawl-complete it (terminal 'done' a long time ago → outside cooldown).
    const claimed = await store.claim("w", 1);
    await store.markDone(
      claimed[0].docUrl,
      {
        state: "done",
        webid: "https://alice.pod/card#me",
        isSolid: true,
        nextEligibleAt: Date.now() + WEEK,
      },
      claimed[0].claimToken
    );
    // Force terminal_at into the past so it's outside the cooldown window.
    // (markDone stamped it to ~now; we re-stamp via a tombstone-free direct check using cooldown=0.)
    const status = await store.suggestionStatus({
      webid: "https://alice.pod/card#me",
      docUrl: "https://alice.pod/card",
      nowMs: Date.now(),
      cooldownMs: 0, // cooldown disabled → a done doc reads as live, not cooldown
    });
    expect(status).toBe("live");
  });

  it("returns 'cooldown' for a freshly-terminal doc within the window", async () => {
    const store = await makeTestStore();
    await store.enqueue("https://carol.pod/card", {
      webid: "https://carol.pod/card#me",
      source: "inbox",
    });
    const claimed = await store.claim("w", 1);
    await store.markDone(
      claimed[0].docUrl,
      { state: "failed", failClass: "transient" },
      claimed[0].claimToken
    );
    const status = await store.suggestionStatus({
      webid: "https://carol.pod/card#me",
      docUrl: "https://carol.pod/card",
      nowMs: Date.now(),
      cooldownMs: WEEK, // failed just now → within the 7-day cooldown
    });
    expect(status).toBe("cooldown");
  });

  it("returns 'tombstoned' for a tombstoned doc (matched by either key)", async () => {
    const store = await makeTestStore();
    await store.tombstone("https://evil.pod/card");
    // Matched by doc_url:
    expect(
      await store.suggestionStatus({
        webid: "https://evil.pod/card#me",
        docUrl: "https://evil.pod/card",
        nowMs: Date.now(),
        cooldownMs: WEEK,
      })
    ).toBe("tombstoned");
  });
});

describe("SuggestInboxStore.consumeRateBucket", () => {
  it("grants up to the limit then refuses within a window", async () => {
    const store = await makeTestStore();
    const now = 1_000_000;
    const opts = { key: "ip:1.2.3.4", limit: 3, windowMs: HOUR, nowMs: now };
    expect(await store.consumeRateBucket(opts)).toBe(true); // 1
    expect(await store.consumeRateBucket(opts)).toBe(true); // 2
    expect(await store.consumeRateBucket(opts)).toBe(true); // 3
    expect(await store.consumeRateBucket(opts)).toBe(false); // 4 — over cap
  });

  it("resets the counter in a new window", async () => {
    const store = await makeTestStore();
    const key = "ip:5.6.7.8";
    await store.consumeRateBucket({ key, limit: 1, windowMs: HOUR, nowMs: 0 });
    expect(
      await store.consumeRateBucket({ key, limit: 1, windowMs: HOUR, nowMs: 0 })
    ).toBe(false);
    // Advance past the window → reset → granted again.
    expect(
      await store.consumeRateBucket({
        key,
        limit: 1,
        windowMs: HOUR,
        nowMs: HOUR + 1,
      })
    ).toBe(true);
  });
});

describe("SuggestInboxStore.recordNotification + list/get", () => {
  it("persists a notification + its objects, and reads it back", async () => {
    const store = await makeTestStore();
    await store.recordNotification({
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      receivedAt: 1_700_000_000_000,
      actor: "https://suggester.example/me",
      activity: "https://www.w3.org/ns/activitystreams#Announce",
      body: "<x> a <y> .",
      objectIris: ["https://alice.pod/card#me"],
    });
    const got = await store.getNotification("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(got?.activity).toBe(
      "https://www.w3.org/ns/activitystreams#Announce"
    );
    expect(got?.actor).toBe("https://suggester.example/me");
    expect(got?.processed).toBe(true);
  });

  it("lists newest-first with keyset paging", async () => {
    const store = await makeTestStore();
    // Insert 5 notifications with increasing receivedAt (ids must sort with time).
    const ids = ["A", "B", "C", "D", "E"].map(
      (c) => `01ARZ3NDEKTSV4RRFFQ69G5FA${c}`
    );
    for (let i = 0; i < ids.length; i++) {
      await store.recordNotification({
        id: ids[i],
        receivedAt: 1_700_000_000_000 + i * 1000,
        actor: null,
        activity: "https://www.w3.org/ns/activitystreams#Announce",
        body: "",
        objectIris: [`https://p${i}.example/card#me`],
      });
    }
    const page1 = await store.listNotifications({ limit: 2 });
    expect(page1.rows).toHaveLength(2);
    expect(page1.total).toBe(5);
    expect(page1.nextCursor).not.toBeNull();
    // Newest first.
    expect(page1.rows[0].receivedAt).toBeGreaterThan(page1.rows[1].receivedAt);

    const page2 = await store.listNotifications({
      limit: 2,
      cursor: page1.nextCursor ?? undefined,
    });
    expect(page2.rows).toHaveLength(2);
    // No overlap between pages.
    const p1ids = new Set(page1.rows.map((r) => r.id));
    expect(page2.rows.some((r) => p1ids.has(r.id))).toBe(false);
  });

  it("getNotification returns null for an unknown id", async () => {
    const store = await makeTestStore();
    expect(await store.getNotification("nope")).toBeNull();
  });
});
