import { Hono } from "hono";
import type { Env } from "./index";
import { BOOK_NUMBERS, DCS_OWNER, dcsFileSize } from "./dcsSources";

// Read-only English T4T (Translation for Translators) scripture, shown beside
// ULT/UST as a reference. Deliberately NOT stored in the D1 `verses` table:
// many backend paths act on every bible_version of a book (bookImport's
// `DELETE FROM verses WHERE book=?`, verse-bridge merge/split, reimport,
// export), and none of them should ever touch T4T. It is also not part of
// dcsUrls() or the nightly sync. The text has not changed since 2014, so the
// raw USFM is cached in R2 once and served from there.
//
// GET /api/t4t/:book → { book, usfm }. JSON (not text/plain) so the web client
// can use the shared fetch client in web/src/sync/api.ts unchanged.
export const t4t = new Hono<{ Bindings: Env }>();

const T4T_REPO = "en_t4t";

t4t.get("/:book", async (c) => {
  const book = c.req.param("book").toUpperCase();
  if (!/^[0-9A-Z]{3}$/.test(book) || !BOOK_NUMBERS[book]) {
    return c.json({ error: "invalid_book" }, 400);
  }
  const key = `t4t/${book}.usfm`;
  const cacheHeaders = { "Cache-Control": "private, max-age=86400" };

  const cached = await c.env.BLOBS.get(key);
  if (cached) {
    return c.json({ book, usfm: await cached.text() }, 200, cacheHeaders);
  }

  const base = (c.env.DCS_BASE_URL ?? "https://git.door43.org").replace(/\/$/, "");
  const path = `${BOOK_NUMBERS[book]}-${book}.usfm`;
  const url = `${base}/${DCS_OWNER}/${T4T_REPO}/raw/branch/master/${path}`;
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    console.error("t4t: DCS fetch failed", { book, err: String(err) });
    return c.json({ error: "upstream_unavailable" }, 502);
  }
  if (res.status === 404) return c.json({ error: "not_found", book }, 404);
  if (!res.ok) {
    console.error("t4t: DCS non-200", { book, status: res.status });
    return c.json({ error: "upstream_error", status: res.status }, 502);
  }
  const buf = await res.arrayBuffer();
  // Reject a truncated or empty body: caching it in R2 would serve the
  // partial text forever (nothing refreshes this key). Content-Length alone
  // is not enough — DCS gzips the raw endpoint and then sends none (measured
  // 2026-11-03) — so compare against the size Gitea records for the file
  // (dcsFileSize, same check as fetchDcsMasterTextVerified). Fail closed when
  // that size is unavailable.
  const expected = await dcsFileSize(c.env, T4T_REPO, path);
  if (buf.byteLength === 0 || expected == null || buf.byteLength !== expected) {
    console.error("t4t: truncated or empty DCS body", { book, expected, got: buf.byteLength });
    return c.json({ error: "upstream_truncated" }, 502);
  }
  const usfm = new TextDecoder("utf-8").decode(buf);
  if (!/\\c\s+1\b/.test(usfm)) {
    console.error("t4t: DCS body has no \\c 1", { book, got: buf.byteLength });
    return c.json({ error: "upstream_truncated" }, 502);
  }
  await c.env.BLOBS.put(key, usfm, { httpMetadata: { contentType: "text/plain; charset=utf-8" } });
  return c.json({ book, usfm }, 200, cacheHeaders);
});
