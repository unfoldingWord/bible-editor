// tw_link → TW article title (the headword line), loaded from tw_articles.
//
// Canonical TWL ordering anchors each link on the English ULT word carrying its
// article's headword (see twlCanonicalOrder.ts). That needs the titles, which
// live in D1 — but twlCanonicalOrder.ts is deliberately a pure leaf module with
// no D1 dependency so it stays loadable by the strip-types test runner and stays
// byte-identically mirrorable into web/. So the D1 read lives here, and both the
// nightly export and the reimport canonicalization post-pass load the map once
// per book and hand it in.
//
// An empty map is a legitimate result (tw_articles not yet imported): ordering
// falls back to its pre-headword behaviour rather than failing.

export async function loadTwTitles(db: D1Database): Promise<Map<string, string>> {
  const rs = await db
    .prepare(`SELECT tw_link, title FROM tw_articles WHERE tw_link IS NOT NULL AND title IS NOT NULL`)
    .all<{ tw_link: string; title: string }>();

  const map = new Map<string, string>();
  for (const r of rs.results) map.set(r.tw_link, r.title);
  return map;
}
