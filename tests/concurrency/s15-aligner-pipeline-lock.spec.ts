import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { csrfToken, newUserContext } from "./helpers";

// S15 — issue #943: the single-verse aligner ignores an AI-pipeline chapter
// lock. Before this fix, `AlignmentPanel` had no lock awareness at all: a
// translator could open the aligner on a chapter a "generate" pipeline run
// currently owns, drag an alignment, click Save, and have the PATCH rejected
// with 409 chapter_locked — wasted work the UI never warned about. The
// history dialog had the same gap: its restore button defaulted to enabled
// (`canRestore` unset ⇒ true), offering a "Switch to vN" the server would
// also reject.
//
// The fix does NOT block entry to the aligner the way a BOOK lock does
// (openAligner/openDualAligner's `bookLocked` guard) — s9's check (b) relies
// on the dual aligner's reading line staying reachable through a chapter
// lock so its PATCH-then-reject-with-toast path keeps working. Instead the
// panel itself goes lock-aware: Save/Clear/Reset/accept-suggestion disable,
// a "chapter locked" note appears, and the history dialog's restore button
// reads "Locked" — mirroring s14's book-locked verse history, but sourced
// from a pipeline chapter lock instead of a book lock.
//
// What this guards:
//   1. Locked: the single aligner still opens (link icon reachable), but
//      Save is disabled, the lock note shows, and the history dialog offers
//      no restore.
//   2. No `PATCH /api/verses/...` fires at any point while locked.
//   3. Unlocked again: the lock note is gone and Save re-enables normally.

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../api");
const wranglerBin = createRequire(resolve(apiDir, "package.json")).resolve(
  "wrangler/bin/wrangler.js",
);

// Seed / clear a chapter-locking pipeline_jobs row directly in the LOCAL D1
// SQLite file `wrangler dev` already has open — same mechanism s9 uses. Never
// touches DCS or a remote database (see CLAUDE.md's dev/prod D1 split).
function d1(sql: string): void {
  const res = spawnSync(
    process.execPath,
    [wranglerBin, "d1", "execute", "bible_editor_dev", "--local", "--command", sql],
    { cwd: apiDir, stdio: "pipe" },
  );
  if (res.status !== 0) {
    throw new Error(
      `wrangler d1 execute failed (status ${res.status}): ${res.stderr?.toString() ?? ""}`,
    );
  }
}

const BOOK = "ZEC";
const CHAPTER = 6;
const VERSE = 2;
const BV = "ULT";
const JOB_ID = "s15-aligner-pipeline-lock";

// One API edit so the verse has a second, non-current version — otherwise
// the history dialog's restore button is disabled anyway (nothing to switch
// to) and the "Locked" label wouldn't distinguish the fix from a no-op.
// Appends a plain text node, leaving every alignment milestone untouched.
async function editVerse(request: APIRequestContext, csrf: string): Promise<number> {
  const path = `/api/verses/${BOOK}/${CHAPTER}/${VERSE}/${BV}`;
  const cur = await request.get(path);
  expect(cur.ok()).toBe(true);
  const row = (await cur.json()) as { version: number; plain_text: string; content_json: string };
  const content = JSON.parse(row.content_json) as { verseObjects: unknown[] };
  content.verseObjects.push({ type: "text", text: " [s15]" });
  const res = await request.patch(path, {
    headers: { "x-csrf-token": csrf, "If-Match": String(row.version) },
    data: { content, plain_text: `${row.plain_text} [s15]` },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { version: number }).version;
}

test("aligner disables save + history restore, and never PATCHes, while an AI run locks the chapter", async ({
  browser,
}) => {
  const { context, auth } = await newUserContext(browser, "s15-aligner-lock");
  const csrf = await csrfToken(context.request);
  const page = await context.newPage();

  // Idempotent: clear any stale row a previous crashed run left behind.
  d1(`DELETE FROM pipeline_jobs WHERE job_id = '${JOB_ID}'`);
  try {
    const current = await editVerse(context.request, csrf);
    expect(current).toBeGreaterThanOrEqual(2);

    // "generate" locks the "verse" resource (api/src/chapterLock.ts).
    d1(
      `INSERT INTO pipeline_jobs (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state) ` +
        `VALUES ('${JOB_ID}', ${auth.userId}, 'generate', '${BOOK}', ${CHAPTER}, ${CHAPTER}, 's15-lock-test', 'running')`,
    );

    const verseWrites: string[] = [];
    page.on("request", (req) => {
      if (req.method() !== "GET" && req.url().includes("/api/verses/")) {
        verseWrites.push(`${req.method()} ${req.url()}`);
      }
    });

    await page.goto(`/#/${BOOK}/${CHAPTER}/${VERSE}`);
    await page.reload();
    await page
      .locator(`[data-find-cell="${CHAPTER}-${VERSE}-${BV}"]`)
      .first()
      .waitFor({ timeout: 15_000 });

    // Entry stays reachable — same reasoning as the dual aligner's reading
    // line (s9 check (b)): only the mutating controls disable.
    await page.locator(`button[aria-label^="align ${BV}"]`).first().click();
    const saveBtn = page.getByRole("button", { name: `Save ${BV}`, exact: true });
    await saveBtn.waitFor({ state: "visible" });

    await expect(page.getByText("chapter locked")).toBeVisible();
    await expect(saveBtn).toBeDisabled();
    await expect(page.getByRole("button", { name: "Clear", exact: true })).toBeDisabled();

    await page
      .getByRole("button", { name: "version history — view or restore an earlier alignment" })
      .click();
    const dialog = page.getByRole("dialog").filter({ hasText: "Verse history" });
    await expect(dialog.getByText("Verse history")).toBeVisible();
    const restore = dialog.getByRole("button", { name: "Locked" });
    await expect(restore).toBeVisible();
    await expect(restore).toBeDisabled();
    await expect(dialog.getByRole("button", { name: /^Switch to v/ })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Close" }).click();

    expect(verseWrites).toEqual([]);

    // Clear the lock: the note disappears (Save stays disabled only because
    // there's nothing dirty to save, not because it's locked).
    d1(`DELETE FROM pipeline_jobs WHERE job_id = '${JOB_ID}'`);
    await page.waitForTimeout(300);
    await page.reload();
    await page
      .locator(`[data-find-cell="${CHAPTER}-${VERSE}-${BV}"]`)
      .first()
      .waitFor({ timeout: 15_000 });
    await page.locator(`button[aria-label^="align ${BV}"]`).first().click();
    await page.getByRole("button", { name: `Save ${BV}`, exact: true }).waitFor({ state: "visible" });
    await expect(page.getByText("chapter locked")).toHaveCount(0);

    expect(verseWrites).toEqual([]);
  } finally {
    d1(`DELETE FROM pipeline_jobs WHERE job_id = '${JOB_ID}'`);
  }

  await context.close();
});
