/**
 * login-ux.ts — tested reference implementation of the "let users pick their
 * Solid server" UX for @solid/reactive-authentication apps.
 *
 * The flow is WebID-first: the user enters (or re-picks) a WebID; the app
 * resolves the OIDC issuer(s) from the profile; when several issuers are
 * advertised the USER chooses — never the first silently. Successful logins
 * are remembered as "recent accounts" (most recent first, deduplicated), so
 * returning users tap an avatar instead of retyping.
 *
 * Published @solid/reactive-authentication 0.1.2 resolves issuers internally
 * from a fixed host map, so the issuer resolved here is used for VALIDATION
 * and UI (clear errors, user choice) today, and becomes the wired-in issuer
 * when the configurable issuer callback ships. Tested with vitest against
 * the published packages (see login-ux.test.ts).
 */
import { fetchRdf } from "@jeswr/fetch-rdf";
import { WebIdDataset, Agent } from "@solid/object";
import { DataFactory } from "n3";
import type { DatasetCore } from "@rdfjs/types";

/** The WebID's profile advertises no solid:oidcIssuer — not usable for Solid login. */
export class NoSolidIssuerError extends Error {
  readonly webId: string;
  constructor(webId: string) {
    super(
      `This WebID can't be used for Solid login — its profile has no solid:oidcIssuer (${webId}).`,
    );
    this.name = "NoSolidIssuerError";
    this.webId = webId;
  }
}

/** The input is not a usable WebID. */
export class InvalidWebIdError extends Error {
  constructor(input: string, reason: string) {
    super(`Not a valid WebID (${reason}): ${input}`);
    this.name = "InvalidWebIdError";
  }
}

/** Validate user input as a WebID: must parse as a URL, scheme http(s) only. */
export function validateWebId(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new InvalidWebIdError(input, "not a URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new InvalidWebIdError(input, "scheme must be http(s)");
  }
  return url.toString();
}

/**
 * Pure resolution from an already-fetched profile dataset: every
 * solid:oidcIssuer on the WebID subject. Throws NoSolidIssuerError when none.
 * One issuer → log straight in; several → present the list, the user picks.
 */
export function resolveIssuers(webId: string, dataset: DatasetCore): string[] {
  const agent = new Agent(webId, dataset, DataFactory);
  const issuers = [...agent.oidcIssuer];
  if (issuers.length === 0) throw new NoSolidIssuerError(webId);
  return issuers;
}

/** Profile data the login UI needs, in one round trip. */
export interface LoginCandidate {
  webId: string;
  issuers: string[];   // length ≥ 1; if > 1 the user must choose
  displayName: string; // for the account card; falls back to the WebID
  avatarUrl?: string;
}

/**
 * Dereference the WebID (public read — uses the patched global fetch, but no
 * auth is needed for public profiles) and assemble what the login UI needs.
 */
export async function fetchLoginCandidate(input: string): Promise<LoginCandidate> {
  const webId = validateWebId(input);
  const { dataset } = await fetchRdf(webId);
  const issuers = resolveIssuers(webId, dataset);
  const me = new WebIdDataset(dataset, DataFactory).mainSubject;
  return {
    webId,
    issuers,
    displayName: me?.name ?? webId,
    avatarUrl: me?.photoUrl ?? undefined,
  };
}

/** A remembered account for the recent-accounts list. */
export interface RecentAccount {
  webId: string;
  displayName: string;
  avatarUrl?: string;
  issuer?: string;  // the issuer the user chose, remembered per account
  storage?: string; // the storage the user chose, remembered per account
}

const STORAGE_KEY = "solid:recent-accounts";
const MAX_ACCOUNTS = 8;

/** Minimal storage contract so tests can inject a stub (localStorage matches it). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Most-recent-first, deduplicated-by-WebID account memory. Survives logout by
 * design — logging out clears the session, not the account list.
 */
export class RecentAccounts {
  readonly #storage: KeyValueStorage;
  constructor(storage: KeyValueStorage = globalThis.localStorage) {
    this.#storage = storage;
  }

  list(): RecentAccount[] {
    try {
      const raw = this.#storage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as RecentAccount[]) : [];
    } catch {
      return []; // corrupt storage is not a login blocker
    }
  }

  /** Add or refresh an account; it moves to the front. */
  remember(account: RecentAccount): void {
    const rest = this.list().filter((a) => a.webId !== account.webId);
    this.#storage.setItem(
      STORAGE_KEY,
      JSON.stringify([account, ...rest].slice(0, MAX_ACCOUNTS)),
    );
  }

  forget(webId: string): void {
    this.#storage.setItem(
      STORAGE_KEY,
      JSON.stringify(this.list().filter((a) => a.webId !== webId)),
    );
  }
}
