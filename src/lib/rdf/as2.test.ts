// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
/**
 * as2.test.ts — AS2 suggestion parse + extract (lib/rdf/as2.ts).
 *
 * Verifies the bundled AS2 @context lets a CONFORMANT JSON-LD notification (whose @context is the
 * REMOTE activitystreams IRI) parse WITHOUT any network fetch, and that `as:object` IRIs are pulled
 * from the EXPANDED quads via typed term matching (never JSON keys).
 */
import { describe, expect, it } from "vitest";

import { ACCEPTED_ACTIVITY_TYPES, parseSuggestion } from "./as2";

const AS2 = "https://www.w3.org/ns/activitystreams#";
const WEBID = "https://alice.pod/card#me";

describe("parseSuggestion — AS2 JSON-LD with the bundled remote @context", () => {
  it("parses a conformant as:Announce and extracts the as:object WebID (no network)", async () => {
    const body = JSON.stringify({
      "@context": "https://www.w3.org/ns/activitystreams",
      type: "Announce",
      actor: "https://suggester.example/profile#me",
      object: WEBID,
    });

    const parsed = await parseSuggestion({
      text: body,
      contentType: "application/ld+json",
      baseIri: "https://index.example/inbox/",
    });

    expect(parsed.activityTypes).toContain(`${AS2}Announce`);
    expect(parsed.objectIris).toEqual([WEBID]);
    expect(parsed.actor).toBe("https://suggester.example/profile#me");
  });

  it("accepts application/activity+json with the same context", async () => {
    const body = JSON.stringify({
      "@context": "https://www.w3.org/ns/activitystreams",
      type: "Offer",
      object: WEBID,
    });
    const parsed = await parseSuggestion({
      text: body,
      contentType: "application/activity+json",
      baseIri: "https://index.example/inbox/",
    });
    // application/activity+json is parsed as JSON-LD by the dispatch (json → ld+json fallback).
    expect(parsed.objectIris).toEqual([WEBID]);
  });

  it("parses a Turtle AS2 notification", async () => {
    const turtle = `@prefix as: <${AS2}> .
<https://index.example/inbox/x> a as:Announce ;
  as:actor <https://suggester.example/me> ;
  as:object <${WEBID}> .`;
    const parsed = await parseSuggestion({
      text: turtle,
      contentType: "text/turtle",
      baseIri: "https://index.example/inbox/",
    });
    expect(parsed.activityTypes).toContain(`${AS2}Announce`);
    expect(parsed.objectIris).toEqual([WEBID]);
  });

  it("extracts multiple as:object IRIs (deduped, IRI objects only)", async () => {
    const turtle = `@prefix as: <${AS2}> .
<x> a as:Announce ; as:object <${WEBID}>, <https://bob.pod/card#me>, <${WEBID}> ;
  as:object "not-a-webid" .`;
    const parsed = await parseSuggestion({
      text: turtle,
      contentType: "text/turtle",
      baseIri: "https://index.example/inbox/",
    });
    expect(parsed.objectIris.sort()).toEqual(
      ["https://bob.pod/card#me", WEBID].sort()
    );
  });

  it("returns no objects when the activity has none", async () => {
    const body = JSON.stringify({
      "@context": "https://www.w3.org/ns/activitystreams",
      type: "Announce",
    });
    const parsed = await parseSuggestion({
      text: body,
      contentType: "application/ld+json",
      baseIri: "https://index.example/inbox/",
    });
    expect(parsed.objectIris).toEqual([]);
  });

  it("REFUSES a remote @context other than AS2 (SSRF guard) → throws", async () => {
    const body = JSON.stringify({
      "@context": "https://evil.example/context.jsonld",
      type: "Announce",
      object: WEBID,
    });
    await expect(
      parseSuggestion({
        text: body,
        contentType: "application/ld+json",
        baseIri: "https://index.example/inbox/",
      })
    ).rejects.toThrow();
  });

  it("rejects malformed JSON-LD", async () => {
    await expect(
      parseSuggestion({
        text: "{ not valid json",
        contentType: "application/ld+json",
        baseIri: "https://index.example/inbox/",
      })
    ).rejects.toThrow();
  });

  it("ACCEPTED_ACTIVITY_TYPES contains Announce, Offer, Add", () => {
    expect(ACCEPTED_ACTIVITY_TYPES).toContain(`${AS2}Announce`);
    expect(ACCEPTED_ACTIVITY_TYPES).toContain(`${AS2}Offer`);
    expect(ACCEPTED_ACTIVITY_TYPES).toContain(`${AS2}Add`);
  });
});

describe("extractSuggestion — restricts to activity subjects when typed", () => {
  it("does NOT harvest as:object from non-activity subjects", async () => {
    // Two subjects: an Announce (with object alice) and a plain resource (with object eve). Only the
    // Announce's object is a candidate.
    const turtle = `@prefix as: <${AS2}> .
<urn:act> a as:Announce ; as:object <${WEBID}> .
<urn:other> as:object <https://eve.example/card#me> .`;
    const parsed = await parseSuggestion({
      text: turtle,
      contentType: "text/turtle",
      baseIri: "https://index.example/inbox/",
    });
    expect(parsed.objectIris).toEqual([WEBID]);
    expect(parsed.objectIris).not.toContain("https://eve.example/card#me");
  });
});

describe("extractSuggestion — AS2 type bypass guard (M2)", () => {
  it("yields NO candidates and NO type for an UNTYPED as:object payload (no harvest fallback)", async () => {
    // An untyped subject carrying as:object MUST NOT surface a candidate — there is no
    // "harvest any as:object" fallback (a non-Announce/Offer/Add payload cannot enqueue a crawl).
    const turtle = `@prefix as: <${AS2}> .
<urn:untyped> as:object <${WEBID}> .`;
    const parsed = await parseSuggestion({
      text: turtle,
      contentType: "text/turtle",
      baseIri: "https://index.example/inbox/",
    });
    expect(parsed.activityTypes).toEqual([]);
    expect(parsed.objectIris).toEqual([]);
  });

  it("yields NO candidates for a non-accepted activity type (e.g. as:Like)", async () => {
    // A typed activity whose type is NOT in the accepted set is treated as untyped → no candidates.
    const turtle = `@prefix as: <${AS2}> .
<urn:act> a as:Like ; as:object <${WEBID}> .`;
    const parsed = await parseSuggestion({
      text: turtle,
      contentType: "text/turtle",
      baseIri: "https://index.example/inbox/",
    });
    expect(parsed.activityTypes).toEqual([]);
    expect(parsed.objectIris).toEqual([]);
  });
});
