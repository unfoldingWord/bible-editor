import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { csrfToken, newUserContext } from "./helpers";

// S17 — issue #943: the aligner ignored an AI-pipeline chapter lock. A
// translator could open the aligner on a chapter a "generate" run owns, drag
// an alignment, click Save, and have the PATCH rejected with 409
// chapter_locked. The history dialog's restore defaulted to enabled too.
//
// Entry is NOT blocked the way a book lock blocks it: s9 check (b) relies on
// the dual aligner's reading line staying reachable through a chapter lock.
// Instead the panel goes read-only: drags do nothing, Save/Clear disable, a
// "chapter locked" note shows, and the history dialog's restore reads
// "Locked" (mirrors s14's book-locked verse history).
//
// What this guards:
//   1. Locked: the aligner opens, a drag does not change the alignment, Save
//      and Clear are disabled, the history dialog offers no restore.
//   2. No `PATCH /api/verses/...` fires while locked.
//   3. Unlocked: the note is gone and the same drag DOES change the alignment
//      (positive control for check 1), then Reset discards it unsaved.

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../api");

// As of wrangler 4.13x, `wrangler/package.json`'s `exports` map no longer
// resolves the `wrangler/bin/wrangler.js` subpath directly (see s9's longer
// comment on the same lookup) — resolve `wrangler/package.json` instead and
// derive the bin path from its directory.
const wranglerBin = resolve(
  dirname(
    createRequire(resolve(apiDir, "package.json")).resolve("wrangler/package.json"),
  ),
  "bin/wrangler.js",
);

// Seed / clear a chapter-locking pipeline_jobs row in the LOCAL D1 file
// `wrangler dev` has open (same mechanism as s9). Never touches remote D1.
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
const JOB_ID = "s17-aligner-pipeline-lock";

// One API edit so the verse has a second, non-current version: otherwise the
// history dialog's restore is disabled anyway (nothing to switch to) and the
// "Locked" label wouldn't distinguish the fix from a no-op. Appends a plain
// text node, leaving every alignment milestone untouched.
async function editVerse(request: APIRequestContext, csrf: string): Promise<number> {
  const path = `/api/verses/${BOOK}/${CHAPTER}/${VERSE}/${BV}`;
  const cur = await request.get(path);
  expect(cur.ok()).toBe(true);
  const row = (await cur.json()) as { version: number; plain_text: string; content_json: string };
  const content = JSON.parse(row.content_json) as { verseObjects: unknown[] };
  content.verseObjects.push({ type: "text", text: " [s17]" });
  const res = await request.patch(path, {
    headers: { "x-csrf-token": csrf, "If-Match": String(row.version) },
    data: { content, plain_text: `${row.plain_text} [s17]` },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { version: number }).version;
}

async function openAligner(page: Page) {
  await page.goto(`/#/${BOOK}/${CHAPTER}/${VERSE}`);
  await page.reload();
  await page
    .locator(`[data-find-cell="${CHAPTER}-${VERSE}-${BV}"]`)
    .first()
    .waitFor({ timeout: 15_000 });
  await page.locator(`button[aria-label^="align ${BV}"]`).first().click();
  await page.getByRole("button", { name: `Save ${BV}`, exact: true }).waitFor({ state: "visible" });
}

// Drag the aligned "horses" chip off its alignment card onto the "ULT words"
// strip, which unaligns it (the strip's own aligned chips are not draggable).
// Returns the strip's "N unaligned" label before and after.
async function dragAlignedWordToStrip(page: Page): Promise<{ before: string; after: string }> {
  const strip = page.getByText(`${BV} words`, { exact: true }).locator("xpath=../..");
  const count = strip.getByText(/^\d+ unaligned$/);
  const before = (await count.textContent()) ?? "";
  const chip = page.locator('[draggable="true"]').filter({ hasText: "horses" }).first();
  await chip.dragTo(page.getByText(`${BV} words`, { exact: true }));
  await page.waitForTimeout(200);
  const after = (await count.textContent()) ?? "";
  return { before, after };
}

test("aligner is read-only (no drag, save or history restore) while an AI run locks the chapter", async ({
  browser,
}) => {
  const { context, auth } = await newUserContext(browser, "s17-aligner-lock");
  const csrf = await csrfToken(context.request);
  const page = await context.newPage();

  d1(`DELETE FROM pipeline_jobs WHERE job_id = '${JOB_ID}'`);
  try {
    const current = await editVerse(context.request, csrf);
    expect(current).toBeGreaterThanOrEqual(2);

    // "generate" locks the "verse" resource (api/src/chapterLock.ts).
    d1(
      `INSERT INTO pipeline_jobs (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state) ` +
        `VALUES ('${JOB_ID}', ${auth.userId}, 'generate', '${BOOK}', ${CHAPTER}, ${CHAPTER}, 's17-lock-test', 'running')`,
    );

    const verseWrites: string[] = [];
    page.on("request", (req) => {
      if (req.method() !== "GET" && req.url().includes("/api/verses/")) {
        verseWrites.push(`${req.method()} ${req.url()}`);
      }
    });

    await openAligner(page);
    const saveBtn = page.getByRole("button", { name: `Save ${BV}`, exact: true });
    const resetBtn = page.getByRole("button", { name: "Reset", exact: true });

    await expect(page.getByText("chapter locked")).toBeVisible();
    await expect(saveBtn).toBeDisabled();
    await expect(page.getByRole("button", { name: "Clear", exact: true })).toBeDisabled();
    // The per-card clear (x) is hidden too: its handler refuses while locked.
    const cardClear = page.getByRole("button", { name: /^clear this group/ });
    await expect(cardClear).toHaveCount(0);

    const locked = await dragAlignedWordToStrip(page);
    expect(locked.after, "a drag must not change the alignment while locked").toBe(locked.before);
    await expect(resetBtn).toBeDisabled(); // nothing dirty
    await expect(saveBtn).toBeDisabled();

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

    // Unlock: the note goes away and the same drag now changes the alignment.
    d1(`DELETE FROM pipeline_jobs WHERE job_id = '${JOB_ID}'`);
    await openAligner(page);
    await expect(page.getByText("chapter locked")).toHaveCount(0);
    expect(await cardClear.count()).toBeGreaterThan(0);
    const unlocked = await dragAlignedWordToStrip(page);
    expect(unlocked.after, "positive control: the drag works when unlocked").not.toBe(unlocked.before);
    await expect(saveBtn).toBeEnabled();
    await resetBtn.click();
    await expect(saveBtn).toBeDisabled();

    expect(verseWrites).toEqual([]);
  } finally {
    d1(`DELETE FROM pipeline_jobs WHERE job_id = '${JOB_ID}'`);
  }

  await context.close();
});
