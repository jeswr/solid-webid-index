// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
// Route runtime: nodejs — required for Node APIs (DNS pinning, undici Agent)
// used by guardedFetch and future LDN/crawl routes. Never switch to edge.
// See docs/DESIGN.md §5 / §4 for the security rationale.
export const runtime = "nodejs";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export default function HomePage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <div className="flex flex-col items-center gap-4 text-center measure">
        <Badge variant="secondary">Under construction</Badge>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">
          WebID Index
        </h1>
        <p className="text-muted-foreground text-base">
          A public, Linked-Data-native index of Solid WebIDs. Search, browse,
          and suggest identities.
        </p>
        <p className="text-sm text-muted-foreground/70">
          Machines get RDF via content negotiation. Browsers get this.
        </p>
      </div>
      <div className="flex gap-3">
        <Button variant="default" disabled>
          Search WebIDs
        </Button>
        <Button variant="outline" disabled>
          Suggest a WebID
        </Button>
      </div>
    </main>
  );
}
