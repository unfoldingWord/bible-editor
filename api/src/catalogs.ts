import { Hono } from "hono";
import type { Env } from "./index";

export const catalogs = new Hono<{ Bindings: Env }>();

// Support references still bootstrap from existing tn_rows usage (a future
// enhancement is to pull the canonical list from en_ta). TW links now prefer
// the canonical en_tw catalog (tw_articles, migration 0032 + scripts/import-tw.mjs)
// and fall back to / union with usage-derived links so nothing regresses before
// the first import and any in-use-but-not-canonical link still autocompletes.
catalogs.get("/", async (c) => {
  const supportRefs = await c.env.DB.prepare(
    `SELECT support_reference AS value, COUNT(*) AS n
     FROM tn_rows
     WHERE support_reference IS NOT NULL AND deleted_at IS NULL
     GROUP BY support_reference
     ORDER BY n DESC
     LIMIT 500`,
  ).all<{ value: string; n: number }>();

  // Canonical en_tw articles (empty until the first import).
  const canonical = await c.env.DB.prepare(
    `SELECT tw_link AS value FROM tw_articles ORDER BY id`,
  ).all<{ value: string }>();

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

  return c.json({
    supportReferences: supportRefs.results.map((r) => r.value),
    twLinks,
  });
});
