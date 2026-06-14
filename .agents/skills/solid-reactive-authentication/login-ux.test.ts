// vitest — runs against the PUBLISHED packages (no network, no DOM).
import { describe, it, expect } from "vitest";
import { parseRdf } from "@jeswr/fetch-rdf";
import {
  validateWebId, resolveIssuers, RecentAccounts,
  NoSolidIssuerError, InvalidWebIdError,
  type KeyValueStorage, type RecentAccount,
} from "./login-ux.js";

const WEBID = "https://alice.example/profile/card#me";

const profile = (extra: string) => `
@prefix foaf: <http://xmlns.com/foaf/0.1/>.
@prefix solid: <http://www.w3.org/ns/solid/terms#>.
<${WEBID}> a foaf:Person ${extra} .
`;

describe("validateWebId", () => {
  it("accepts https and returns the normalised string", () => {
    expect(validateWebId("  https://alice.example/profile/card#me ")).toBe(WEBID);
  });
  it("rejects non-URLs and non-http(s) schemes", () => {
    expect(() => validateWebId("not a url")).toThrow(InvalidWebIdError);
    expect(() => validateWebId("ftp://alice.example/card#me")).toThrow(InvalidWebIdError);
  });
});

describe("resolveIssuers", () => {
  it("returns the single issuer", async () => {
    const ds = await parseRdf(
      profile(`; solid:oidcIssuer <https://solidcommunity.net>`),
      "text/turtle",
    );
    expect(resolveIssuers(WEBID, ds)).toEqual(["https://solidcommunity.net"]);
  });

  it("returns ALL issuers when several are advertised (user must choose)", async () => {
    const ds = await parseRdf(
      profile(
        `; solid:oidcIssuer <https://solidcommunity.net>, <https://login.inrupt.com>`,
      ),
      "text/turtle",
    );
    const issuers = resolveIssuers(WEBID, ds);
    expect(issuers).toHaveLength(2);
    expect(issuers).toContain("https://solidcommunity.net");
    expect(issuers).toContain("https://login.inrupt.com");
  });

  it("throws NoSolidIssuerError (with an actionable message) when none", async () => {
    const ds = await parseRdf(profile(`; foaf:name "Alice"`), "text/turtle");
    expect(() => resolveIssuers(WEBID, ds)).toThrow(NoSolidIssuerError);
    expect(() => resolveIssuers(WEBID, ds)).toThrow(/no solid:oidcIssuer/);
  });
});

describe("RecentAccounts", () => {
  const memoryStorage = (): KeyValueStorage => {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
  };
  const acct = (n: number): RecentAccount => ({
    webId: `https://u${n}.example/card#me`,
    displayName: `User ${n}`,
  });

  it("most-recent-first, deduplicated by WebID", () => {
    const r = new RecentAccounts(memoryStorage());
    r.remember(acct(1));
    r.remember(acct(2));
    r.remember({ ...acct(1), displayName: "User 1 again" }); // refresh → front
    const list = r.list();
    expect(list.map((a) => a.displayName)).toEqual(["User 1 again", "User 2"]);
  });

  it("caps the list and survives corrupt storage", () => {
    const s = memoryStorage();
    const r = new RecentAccounts(s);
    for (let i = 0; i < 12; i++) r.remember(acct(i));
    expect(r.list()).toHaveLength(8);
    s.setItem("solid:recent-accounts", "{corrupt");
    expect(r.list()).toEqual([]); // never blocks login
  });

  it("forget removes one account, keeps the rest", () => {
    const r = new RecentAccounts(memoryStorage());
    r.remember(acct(1));
    r.remember(acct(2));
    r.forget(acct(1).webId);
    expect(r.list().map((a) => a.displayName)).toEqual(["User 2"]);
  });

  it("remembers the user's chosen issuer and storage per account", () => {
    const r = new RecentAccounts(memoryStorage());
    r.remember({ ...acct(1), issuer: "https://solidcommunity.net", storage: "https://u1.example/" });
    expect(r.list()[0].issuer).toBe("https://solidcommunity.net");
    expect(r.list()[0].storage).toBe("https://u1.example/");
  });
});
