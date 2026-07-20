import { Hono } from "hono";
import type { Env } from "./index";
import { buildTermMapFromArticles, type TwArticleLite } from "./twlMatcher";
import { TA_SUPPORT_REFERENCES } from "./taSupportReferences";

export const catalogs = new Hono<{ Bindings: Env }>();

const TW_LINK_PREFIX = "rc://*/tw/dict/bible/";

// First heading line, minus the leading "# " — the synonym list a translator
// reads to tell sibling articles apart (e.g. "call (speak), called, calling").
function cleanTitle(title: string | null): string {
  return (title ?? "").split("\n")[0].replace(/^#+\s*/, "").trim();
}

// A word like "call" maps to several articles (kt/call-speakloudly,
// kt/call-toname, kt/call-tosummon). The TWL suggestions panel already surfaces
// this set when ADDING a link; this rebuilds it for COMMITTED links so the
// Words panel can flag a link that had alternatives and let the editor switch
// among them without retyping. Detection mirrors the matcher: two articles are
// siblings if they share any normalized heading term (direct, not transitive,
// so unrelated families don't chain together).
function buildDisambiguation(articles: TwArticleLite[]) {
  const termMap = buildTermMapFromArticles(articles);
  const titleById = new Map(articles.map((a) => [a.id, cleanTitle(a.title)]));
  const linkOf = (id: string) => `${TW_LINK_PREFIX}${id}`;

  // article id -> set of sibling ids (including itself).
  const siblings = new Map<string, Set<string>>();
  for (const ids of Object.values(termMap)) {
    if (ids.length < 2) continue;
    for (const id of ids) {
      let set = siblings.get(id);
      if (!set) siblings.set(id, (set = new Set()));
      for (const other of ids) set.add(other);
    }
  }

  // Dedupe identical sibling-sets into shared groups; index maps each link to
  // its group. Skip pathologically large families (a too-generic term) so the
  // picker stays usable.
  const groups: { link: string; title: string }[][] = [];
  const index: Record<string, number> = {};
  const keyToIdx = new Map<string, number>();
  for (const [id, set] of siblings) {
    if (set.size < 2 || set.size > 12) continue;
    const memberIds = [...set].sort();
    const key = memberIds.join("|");
    let idx = keyToIdx.get(key);
    if (idx === undefined) {
      idx = groups.length;
      keyToIdx.set(key, idx);
      groups.push(memberIds.map((mid) => ({ link: linkOf(mid), title: titleById.get(mid) ?? "" })));
    }
    index[linkOf(id)] = idx;
  }
  return { groups, index };
}

// Support references are served from the curated canonical TA list
// (taSupportReferences.ts) — the notes picker restricts to these. TW links prefer
// the canonical en_tw catalog (tw_articles, migration 0032 + scripts/import-tw.mjs)
// and fall back to / union with usage-derived links so nothing regresses before
// the first import and any in-use-but-not-canonical link still autocompletes.
catalogs.get("/", async (c) => {
  // Canonical en_tw articles (empty until the first import). id + title also
  // feed the disambiguation groups below.
  const canonical = await c.env.DB.prepare(
    `SELECT id, title, tw_link AS value FROM tw_articles ORDER BY id`,
  ).all<{ id: string; title: string; value: string }>();

  // Usage-derived links (most-used first) — covers the pre-import case and any
  // link a row carries that the canonical catalog doesn't (legacy / custom).
  const usage = await c.env.DB.prepare(
    `SELECT tw_link AS value, COUNT(*) AS n
     FROM twl_rows
     WHERE tw_link IS NOT NULL AND deleted_at IS NULL
     GROUP BY tw_link
     ORDER BY n DESC
     LIMIT 500`,
  ).all<{ value: string; n: number }>();

  // Canonical first (stable, complete), then any usage-only extras appended.
  const seen = new Set<string>();
  const twLinks: string[] = [];
  for (const r of canonical.results) {
    if (r.value && !seen.has(r.value)) {
      seen.add(r.value);
      twLinks.push(r.value);
    }
  }
  for (const r of usage.results) {
    if (r.value && !seen.has(r.value)) {
      seen.add(r.value);
      twLinks.push(r.value);
    }
  }

  const disambiguation = buildDisambiguation(
    canonical.results.map((r) => ({ id: r.id, title: r.title })),
  );

  // tw_link → article title (the headword line, synonyms comma-separated).
  // Canonical TWL ordering anchors each link on the English ULT word carrying
  // its TW headword, and the live client MUST compute the same order the
  // nightly export writes — so the client needs the same titles the server
  // orders with. ~950 short entries riding along on a request the client
  // already makes once and persists.
  const twTitles: Record<string, string> = {};
  for (const r of canonical.results) {
    if (r.value && r.title) twTitles[r.value] = r.title;
  }

  return c.json({
    supportReferences: TA_SUPPORT_REFERENCES,
    twLinks,
    twTitles,
    disambiguationGroups: disambiguation.groups,
    disambiguationIndex: disambiguation.index,
  });
});
