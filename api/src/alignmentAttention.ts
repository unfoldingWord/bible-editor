// Sticky per-book "needs alignment attention" indicator. Backed by
// alignment_attention (migration 0041), which exportWorkflow.ts's
// recordAlignmentAttention/clearAlignmentAttention replace-all per
// (book,resource) on every nightly export. Unlike /api/alerts/me this is not
// user-scoped or dismissible — it reflects the last export's findings for
// the book, available to any signed-in user.

import { Hono } from "hono";
import type { Env } from "./index";
import { requireAuth } from "./auth";

export const alignmentAttention = new Hono<{
  Bindings: Env;
  Variables: { userId?: number; username?: string };
}>();

alignmentAttention.use("*", requireAuth);

interface AlignmentAttentionRow {
  resource: string;
  ref: string;
  lost_words: string;
  provenance: string | null;
}

alignmentAttention.get("/:book", async (c) => {
  const book = c.req.param("book");
  const rs = await c.env.DB.prepare(
    `SELECT resource, ref, lost_words, provenance
       FROM alignment_attention
      WHERE book = ?1`,
  )
    .bind(book)
    .all<AlignmentAttentionRow>();
  const refs = (rs.results ?? [])
    .map((r) => {
      const [chapterPart, versePart] = r.ref.split(":");
      const chapter = parseInt(chapterPart, 10);
      const verse = parseInt((versePart ?? "").split("-")[0], 10);
      let lostWords: string[];
      try {
        const parsed = JSON.parse(r.lost_words);
        lostWords = Array.isArray(parsed) ? parsed : [];
      } catch {
        // A malformed lost_words value must not break the whole endpoint —
        // fall back to an empty list rather than throwing.
        lostWords = [];
      }
      return {
        resource: r.resource,
        ref: r.ref,
        chapter,
        verse,
        lostWords,
        provenance: r.provenance,
      };
    })
    .sort((a, b) => a.chapter - b.chapter || a.verse - b.verse || a.resource.localeCompare(b.resource));
  return c.json({ refs });
});
