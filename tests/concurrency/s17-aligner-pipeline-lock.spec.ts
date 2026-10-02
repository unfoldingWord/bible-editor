import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type APIRequestContext, type Page, type Response } from "@playwright/test";
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
const wranglerBin = createRequire(resolve(apiDir, "package.json")).resolve(
  "wrangler/bin/wrangler.js",
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

// #1045: a pipeline lock that lands while the aligner already holds unsaved
// drags. The unsaved-changes gates used to offer Save, which committed the
// drags locally (baseline reset, crash draft cleared) and queued a PATCH the
// server refused with 409 chapter_locked, so the outbox dropped it and the
// drags were gone. While locked the gates must offer no Save, the drags must
// stay (in the panel and the crash draft), and once the lock clears they save.

// The tab learns about a pipeline lock from pipelineStore: a 120 s poll, or a
// visibilitychange refocus throttled to one successful list load per 60 s.
// These tests run on Playwright's clock (installed before the page loads), so
// jump past the throttle and fire the refocus instead of waiting it out.
async function refreshPipelineJobs(page: Page) {
  await page.clock.fastForward(61_000);
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
}

function lockChapter(userId: number, sessionKey: string) {
  d1(
    `INSERT INTO pipeline_jobs (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state) ` +
      `VALUES ('${JOB_ID}', ${userId}, 'generate', '${BOOK}', ${CHAPTER}, ${CHAPTER}, '${sessionKey}', 'running')`,
  );
}

// Crash-draft records under `key` in the aligner's IndexedDB store
// (web/src/sync/alignmentDrafts.ts).
async function crashDraftCount(page: Page, key: string): Promise<number> {
  return page.evaluate(
    (k) =>
      new Promise<number>((resolveCount, reject) => {
        const req = indexedDB.open("bible-editor-alignment-drafts");
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("drafts")) {
            db.close();
            resolveCount(0);
            return;
          }
          const get = db.transaction("drafts", "readonly").objectStore("drafts").count(k);
          get.onsuccess = () => {
            db.close();
            resolveCount(get.result);
          };
          get.onerror = () => reject(get.error);
        };
      }),
    key,
  );
}

// Unaligning "horses" trips the "word will be unaligned" confirm when the
// verse has no other aligned "horses" (ZEC 6:2 has two). Click through it if
// it opens, then return the PATCH status.
async function confirmUnalignIfAsked(page: Page, patched: Promise<Response>): Promise<number> {
  const anyway = page.getByRole("button", { name: "Save anyway", exact: true });
  await Promise.race([patched, anyway.click().catch(() => undefined)]);
  return (await patched).status();
}

const DRAFT_KEY = `${BOOK}:${CHAPTER}:${VERSE}:${BV}`;
const VERSE_PATH = `/api/verses/${BOOK}/${CHAPTER}/${VERSE}/${BV}`;

// Snapshot the verse so a test can put the seeded alignment back: the
// post-unlock save unaligns "horses", which the tests above need aligned.
async function snapshotVerse(request: APIRequestContext) {
  const res = await request.get(VERSE_PATH);
  expect(res.ok()).toBe(true);
  const row = (await res.json()) as { plain_text: string; content_json: string };
  return { content_json: row.content_json, plain_text: row.plain_text };
}

async function restoreVerse(
  request: APIRequestContext,
  csrf: string,
  snap: { content_json: string; plain_text: string },
) {
  const cur = (await (await request.get(VERSE_PATH)).json()) as { version: number; content_json: string };
  if (cur.content_json === snap.content_json) return;
  const res = await request.patch(VERSE_PATH, {
    headers: { "x-csrf-token": csrf, "If-Match": String(cur.version) },
    data: {
      content: JSON.parse(snap.content_json),
      plain_text: snap.plain_text,
      alignment_intent: "alignment_edit",
    },
  });
  expect(res.status(), await res.text()).toBe(200);
}

test("a pipeline lock landing on unsaved drags: the nav gate offers no Save, the drags survive, and they save after the lock clears", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const { context, auth } = await newUserContext(browser, "s17-aligner-lock-gate");
  const csrf = await csrfToken(context.request);
  const page = await context.newPage();
  await page.clock.install();

  d1(`DELETE FROM pipeline_jobs WHERE job_id = '${JOB_ID}'`);
  const snap = await snapshotVerse(context.request);
  try {
    const verseWrites: string[] = [];
    page.on("request", (req) => {
      if (req.method() !== "GET" && req.url().includes("/api/verses/")) {
        verseWrites.push(`${req.method()} ${req.url()}`);
      }
    });

    await openAligner(page);
    const saveBtn = page.getByRole("button", { name: `Save ${BV}`, exact: true });
    const count = page
      .getByText(`${BV} words`, { exact: true })
      .locator("xpath=../..")
      .getByText(/^\d+ unaligned$/);

    // 1. Unlocked drag: the panel is dirty and the crash draft is written.
    const dragged = await dragAlignedWordToStrip(page);
    expect(dragged.after, "the drag must change the alignment while unlocked").not.toBe(dragged.before);
    await expect(saveBtn).toBeEnabled();
    await expect.poll(() => crashDraftCount(page, DRAFT_KEY), { timeout: 5_000 }).toBe(1);

    // 2. The lock lands while the drags are unsaved.
    lockChapter(auth.userId, "s17-lock-gate");
    await refreshPipelineJobs(page);
    await expect(page.getByText("chapter locked")).toBeVisible({ timeout: 15_000 });
    await expect(count).toHaveText(dragged.after);

    // 3. Leaving the aligner opens the gate, which offers no Save while locked.
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const gate = page.getByRole("dialog").filter({ hasText: "Unsaved alignment changes" });
    await expect(gate).toBeVisible();
    await expect(gate.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    await gate.getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect(gate).toHaveCount(0);

    // The drags survive, in the panel and the crash draft, and nothing was sent.
    await expect(count).toHaveText(dragged.after);
    expect(await crashDraftCount(page, DRAFT_KEY)).toBe(1);
    await page.waitForTimeout(500);
    expect(verseWrites).toEqual([]);

    // 4. The lock clears: the same drags save with a 200.
    d1(`DELETE FROM pipeline_jobs WHERE job_id = '${JOB_ID}'`);
    await refreshPipelineJobs(page);
    await expect(page.getByText("chapter locked")).toHaveCount(0, { timeout: 15_000 });
    await expect(count).toHaveText(dragged.after);
    await expect(saveBtn).toBeEnabled();
    const patched = page.waitForResponse(
      (r) => r.request().method() === "PATCH" && r.url().includes(VERSE_PATH),
    );
    await saveBtn.click();
    expect(await confirmUnalignIfAsked(page, patched)).toBe(200);
    await expect(saveBtn).toBeDisabled();
  } finally {
    d1(`DELETE FROM pipeline_jobs WHERE job_id = '${JOB_ID}'`);
    await restoreVerse(context.request, csrf, snap);
  }

  await context.close();
});

test("dual aligner: a pipeline lock landing on unsaved drags leaves Save off the close gate until the lock clears", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const { context, auth } = await newUserContext(browser, "s17-dual-lock-gate");
  const csrf = await csrfToken(context.request);
  const page = await context.newPage();
  await page.clock.install();

  d1(`DELETE FROM pipeline_jobs WHERE job_id = '${JOB_ID}'`);
  const snap = await snapshotVerse(context.request);
  try {
    const verseWrites: string[] = [];
    page.on("request", (req) => {
      if (req.method() !== "GET" && req.url().includes("/api/verses/")) {
        verseWrites.push(`${req.method()} ${req.url()}`);
      }
    });

    await openAligner(page);
    await page.locator("button", { hasText: "Side-by-side" }).first().click();
    const dual = page.getByRole("dialog").filter({ hasText: "reading text" });
    const wordsLabel = dual.getByText(`${BV} words`, { exact: true });
    await wordsLabel.waitFor({ state: "visible" });
    const count = wordsLabel.locator("xpath=../..").getByText(/^\d+ unaligned$/);
    const before = (await count.textContent()) ?? "";
    await dual.locator('[draggable="true"]').filter({ hasText: "horses" }).first().dragTo(wordsLabel);
    await expect(count).not.toHaveText(before);
    const after = (await count.textContent()) ?? "";
    await expect.poll(() => crashDraftCount(page, DRAFT_KEY), { timeout: 5_000 }).toBe(1);

    lockChapter(auth.userId, "s17-dual-lock-gate");
    await refreshPipelineJobs(page);
    await expect(page.getByText("chapter locked").first()).toBeVisible({ timeout: 15_000 });

    const close = dual.locator('button:has(svg[data-testid="CloseIcon"])').first();
    const gate = page.getByRole("dialog").filter({ hasText: "Unsaved changes" });
    await close.click();
    await expect(gate).toBeVisible();
    await expect(gate.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    await gate.getByRole("button", { name: "Keep editing", exact: true }).click();
    await expect(gate).toHaveCount(0);
    await expect(count).toHaveText(after);
    expect(await crashDraftCount(page, DRAFT_KEY)).toBe(1);
    await page.waitForTimeout(500);
    expect(verseWrites).toEqual([]);

    // The lock clears: the gate's Save is back and lands with a 200.
    d1(`DELETE FROM pipeline_jobs WHERE job_id = '${JOB_ID}'`);
    await refreshPipelineJobs(page);
    await expect(page.getByText("chapter locked")).toHaveCount(0, { timeout: 15_000 });
    await expect(count).toHaveText(after);
    const patched = page.waitForResponse(
      (r) => r.request().method() === "PATCH" && r.url().includes(VERSE_PATH),
    );
    await close.click();
    await gate.getByRole("button", { name: "Save", exact: true }).click();
    expect(await confirmUnalignIfAsked(page, patched)).toBe(200);
    await expect(dual).toHaveCount(0);
  } finally {
    d1(`DELETE FROM pipeline_jobs WHERE job_id = '${JOB_ID}'`);
    await restoreVerse(context.request, csrf, snap);
  }

  await context.close();
});
