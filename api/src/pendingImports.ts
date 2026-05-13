// GET /api/pending-imports?book=&chapter= — surfaces unresolved AI-pipeline
// proposals for a chapter. Phase 2b read-side; the accept/reject path comes in
// Phase 2d.
//
// We deliberately do NOT scope proposals to the user who triggered the
// pipeline. Translators work on shared chapters; anyone with an editor session
// should be able to see the queue. Ownership of pipeline_jobs is still
// enforced for the start/poll endpoints — that's about who can spend the bot's
// budget, not about review visibility.

import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./index";
import { requireAuth } from "./auth";

export const pendingImports = new Hono<{
  Bindings: Env;
  Variables: { userId?: number; username?: string };
}>();

const Query = z.object({
  book: z.string().min(1).max(8),
  chapter: z.coerce.number().int().nonnegative(),
});

interface PendingImportRow {
  id: number;
  job_id: string;
  kind: "tn" | "tq" | "verse";
  book: string;
  chapter: number;
  verse: number;
  bible_version: string | null;
  payload_json: string;
  created_at: number;
  pipeline_type: string;
  started_by_username: string | null;
}

pendingImports.get("/", requireAuth, async (c) => {
  const parsed = Query.safeParse({
    book: c.req.query("book"),
    chapter: c.req.query("chapter"),
  });
  if (!parsed.success) {
    return c.json({ error: "validation_failed", issues: parsed.error.issues }, 400);
  }
  const book = parsed.data.book.toUpperCase();
  const chapter = parsed.data.chapter;

  const rs = await c.env.DB.prepare(
    `SELECT pi.id, pi.job_id, pi.kind, pi.book, pi.chapter, pi.verse,
            pi.bible_version, pi.payload_json, pi.created_at,
            pj.pipeline_type, u.dcs_username AS started_by_username
       FROM pending_imports pi
       JOIN pipeline_jobs pj ON pj.job_id = pi.job_id
       LEFT JOIN users u ON u.id = pj.user_id
      WHERE pi.book = ?1 AND pi.chapter = ?2
        AND pi.accepted_at IS NULL AND pi.rejected_at IS NULL
      ORDER BY pi.kind, pi.verse, pi.id`,
  )
    .bind(book, chapter)
    .all<PendingImportRow>();

  const items = (rs.results ?? []).map((r) => ({
    id: r.id,
    jobId: r.job_id,
    kind: r.kind,
    book: r.book,
    chapter: r.chapter,
    verse: r.verse,
    bibleVersion: r.bible_version,
    // Parse payload server-side so every client gets the structured shape.
    payload: safeParse(r.payload_json),
    createdAt: r.created_at,
    pipelineType: r.pipeline_type,
    startedByUsername: r.started_by_username,
  }));

  return c.json({ items });
});

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
