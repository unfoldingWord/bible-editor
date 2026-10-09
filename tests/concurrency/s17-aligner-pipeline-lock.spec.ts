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
async function dragAlignedWordToStrip(page: Page, word = "horses"): Promise<{ before: string; after: string }> {
  const strip = page.getByText(`${BV} words`, { exact: true }).locator("xpath=../..");
  const count = strip.getByText(/^\d+ unaligned$/);
  const before = (await count.textContent()) ?? "";
  const chip = page.locator('[draggable="true"]').filter({ hasText: word }).first();
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

// #1071: two paths #1045 left open. (a) The server holds a lock the tab has
// not polled yet, so the gate still offers Save; its PATCH gets 409
// chapter_locked and the outbox drops it. (b) A lock lands while the "Words
// will be unaligned" confirm is open, and "Save anyway" still committed. In
// both the panel had already reset its baseline and cleared its crash draft,
// so the drags were gone. Now a refused save keeps them, and the confirm
// re-checks the lock before it commits.

test("a lock the tab has not seen yet: the gate's Save is refused with 409, the drags survive, and they save after the lock clears", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const { context, auth } = await newUserContext(browser, "s17-unseen-lock-gate");
  const csrf = await csrfToken(context.request);
  const page = await context.newPage();
  await page.clock.install();

  d1(`DELETE FROM pipeline_jobs WHERE job_id = '${JOB_ID}'`);
  const snap = await snapshotVerse(context.request);
  try {
    await openAligner(page);
    const saveBtn = page.getByRole("button", { name: `Save ${BV}`, exact: true });
    const count = page
      .getByText(`${BV} words`, { exact: true })
      .locator("xpath=../..")
      .getByText(/^\d+ unaligned$/);

    const dragged = await dragAlignedWordToStrip(page);
    expect(dragged.after, "the drag must change the alignment while unlocked").not.toBe(dragged.before);
    await expect.poll(() => crashDraftCount(page, DRAFT_KEY), { timeout: 5_000 }).toBe(1);

    // The lock lands server-side only: no poll, no refocus.
    lockChapter(auth.userId, "s17-unseen-lock-gate");
    await expect(page.getByText("chapter locked")).toHaveCount(0);

    // The gate still offers Save (the tab doesn't know), and the server refuses it.
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const gate = page.getByRole("dialog").filter({ hasText: "Unsaved alignment changes" });
    await expect(gate).toBeVisible();
    const refused = page.waitForResponse(
      (r) => r.request().method() === "PATCH" && r.url().includes(VERSE_PATH),
    );
    await gate.getByRole("button", { name: "Save", exact: true }).click();
    expect(await confirmUnalignIfAsked(page, refused)).toBe(409);

    // The drags survive in the crash draft.
    await expect.poll(() => crashDraftCount(page, DRAFT_KEY), { timeout: 5_000 }).toBe(1);

    // The refusal re-read the lock: reopening the aligner shows it locked
    // (no poll or refocus has run) with the drags restored.
    await page.locator(`button[aria-label^="align ${BV}"]`).first().click();
    await saveBtn.waitFor({ state: "visible" });
    await expect(page.getByText("chapter locked")).toBeVisible({ timeout: 15_000 });
    await expect(count).toHaveText(dragged.after);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(gate).toBeVisible();
    await expect(gate.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    await gate.getByRole("button", { name: "Keep editing", exact: true }).click();

    // The lock clears: the same drags save with a 200.
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

test("a lock the tab has not seen yet: the panel's own Save is refused with 409 and the panel stays unsaved", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const { context, auth } = await newUserContext(browser, "s17-unseen-lock-panel");
  const csrf = await csrfToken(context.request);
  const page = await context.newPage();
  await page.clock.install();

  d1(`DELETE FROM pipeline_jobs WHERE job_id = '${JOB_ID}'`);
  const snap = await snapshotVerse(context.request);
  try {
    await openAligner(page);
    const saveBtn = page.getByRole("button", { name: `Save ${BV}`, exact: true });
    const resetBtn = page.getByRole("button", { name: "Reset", exact: true });
    const count = page
      .getByText(`${BV} words`, { exact: true })
      .locator("xpath=../..")
      .getByText(/^\d+ unaligned$/);

    const dragged = await dragAlignedWordToStrip(page);
    expect(dragged.after).not.toBe(dragged.before);

    lockChapter(auth.userId, "s17-unseen-lock-panel");
    const refused = page.waitForResponse(
      (r) => r.request().method() === "PATCH" && r.url().includes(VERSE_PATH),
    );
    await saveBtn.click();
    expect(await confirmUnalignIfAsked(page, refused)).toBe(409);

    // Still unsaved: the panel turns locked, keeps the drags, Reset stays
    // available, and the crash draft holds them.
    await expect(page.getByText("chapter locked")).toBeVisible({ timeout: 15_000 });
    await expect(count).toHaveText(dragged.after);
    await expect(resetBtn).toBeEnabled();
    await expect.poll(() => crashDraftCount(page, DRAFT_KEY), { timeout: 5_000 }).toBe(1);

    d1(`DELETE FROM pipeline_jobs WHERE job_id = '${JOB_ID}'`);
    await refreshPipelineJobs(page);
    await expect(page.getByText("chapter locked")).toHaveCount(0, { timeout: 15_000 });
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

test("a lock landing while the unalign confirm is open: Save anyway refuses, the drags survive, and they save after the lock clears", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const { context, auth } = await newUserContext(browser, "s17-lock-in-confirm");
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

    // Clear unaligns every word, so Save always opens the unalign confirm.
    const before = (await count.textContent()) ?? "";
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await expect(count).not.toHaveText(before);
    const after = (await count.textContent()) ?? "";
    await expect.poll(() => crashDraftCount(page, DRAFT_KEY), { timeout: 5_000 }).toBe(1);

    await saveBtn.click();
    const confirm = page.getByRole("dialog").filter({ hasText: /will be unaligned/ });
    await expect(confirm).toBeVisible();

    // The lock lands while the confirm is open.
    lockChapter(auth.userId, "s17-lock-in-confirm");
    await refreshPipelineJobs(page);
    await expect(page.getByText("chapter locked")).toBeVisible({ timeout: 15_000 });

    await confirm.getByRole("button", { name: "Save anyway", exact: true }).click();
    await expect(confirm).toHaveCount(0);
    await expect(page.getByText(/so the alignment was not saved/)).toBeVisible();

    // Nothing was sent, and the drags survive in the panel and the crash draft.
    await page.waitForTimeout(500);
    expect(verseWrites).toEqual([]);
    await expect(count).toHaveText(after);
    expect(await crashDraftCount(page, DRAFT_KEY)).toBe(1);
    await expect(page.getByRole("button", { name: "Reset", exact: true })).toBeEnabled();

    // The lock clears: the same drags save with a 200.
    d1(`DELETE FROM pipeline_jobs WHERE job_id = '${JOB_ID}'`);
    await refreshPipelineJobs(page);
    await expect(page.getByText("chapter locked")).toHaveCount(0, { timeout: 15_000 });
    await expect(count).toHaveText(after);
    const patched = page.waitForResponse(
      (r) => r.request().method() === "PATCH" && r.url().includes(VERSE_PATH),
    );
    await saveBtn.click();
    await confirm.getByRole("button", { name: "Save anyway", exact: true }).click();
    expect((await patched).status()).toBe(200);
    await expect(saveBtn).toBeDisabled();
  } finally {
    d1(`DELETE FROM pipeline_jobs WHERE job_id = '${JOB_ID}'`);
    await restoreVerse(context.request, csrf, snap);
  }

  await context.close();
});

// #1071 re-review: on a range row the PATCH is keyed by the row's
// verse_start, but the aligner's crash draft by the verse it was opened on.
// Bridge ZEC 7:6-7 UST, open the dual aligner on v7, and refuse its save
// under a lock the tab has not seen: the draft must come back under v7's key.
test("a range row opened on its inner verse: a refused save's drags come back under that verse's draft key", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const { context, auth } = await newUserContext(browser, "s17-range-lock");
  const csrf = await csrfToken(context.request);
  const page = await context.newPage();
  await page.clock.install();
  const UST = "UST";
  const V6 = `/api/verses/${BOOK}/7/6/${UST}`;
  const V7 = `/api/verses/${BOOK}/7/7/${UST}`;
  const RANGE_JOB = "s17-range-lock";
  type Row = { version: number; plain_text: string; content_json: string; verse_end: number | null };
  const get = async (path: string) => {
    const res = await context.request.get(path);
    expect(res.ok()).toBe(true);
    return (await res.json()) as Row;
  };
  const clearLock = () => d1(`DELETE FROM pipeline_jobs WHERE job_id = '${RANGE_JOB}'`);
  clearLock();
  const orig6 = await get(V6);
  const orig7 = await get(V7);
  expect(orig6.verse_end).toBeNull();
  let bridged = false;
  try {
    const res = await context.request.post(`${V6}/bridge`, {
      headers: { "x-csrf-token": csrf },
      data: { start_version: orig6.version, next_version: orig7.version },
    });
    expect(res.status(), await res.text()).toBe(200);
    bridged = true;

    await page.goto(`/#/${BOOK}/7/7`);
    await page.reload();
    await page.locator(`[data-find-cell="7-7-ULT"]`).first().waitFor({ timeout: 15_000 });
    await page.locator(`button[aria-label^="align ULT"]`).first().click();
    const sideBySide = page.locator("button", { hasText: "Side-by-side" }).first();
    await sideBySide.click();
    const dual = page.getByRole("dialog").filter({ hasText: "reading text" });
    const wordsLabel = dual.getByText(`${UST} words`, { exact: true });
    await wordsLabel.waitFor({ state: "visible" });
    const count = wordsLabel.locator("xpath=../..").getByText(/^\d+ unaligned$/);
    const before = (await count.textContent()) ?? "";
    // Right panel (UST) Clear: unaligns everything, so Save asks first.
    await dual.getByRole("button", { name: "Clear", exact: true }).nth(1).click();
    await expect(count).not.toHaveText(before);
    const after = (await count.textContent()) ?? "";
    const innerKey = `${BOOK}:7:7:${UST}`;
    await expect.poll(() => crashDraftCount(page, innerKey), { timeout: 5_000 }).toBe(1);

    // Lock lands server-side only; the dual gate's Save is refused.
    d1(
      `INSERT INTO pipeline_jobs (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state) ` +
        `VALUES ('${RANGE_JOB}', ${auth.userId}, 'generate', '${BOOK}', 7, 7, 's17-range-lock', 'running')`,
    );
    const refused = page.waitForResponse(
      (r) => r.request().method() === "PATCH" && r.url().includes(V6),
    );
    await dual.locator('button:has(svg[data-testid="CloseIcon"])').first().click();
    const gate = page.getByRole("dialog").filter({ hasText: "Unsaved changes" });
    await gate.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("button", { name: "Save anyway", exact: true }).click();
    expect((await refused).status()).toBe(409);

    // The draft is back under the key the panel reads (v7), not the row's v6.
    await expect.poll(() => crashDraftCount(page, innerKey), { timeout: 5_000 }).toBe(1);
    expect(await crashDraftCount(page, `${BOOK}:7:6:${UST}`)).toBe(0);
    await expect(page.getByText(/Your changes are kept in the aligner/)).toBeVisible();

    // The lock clears; reopening shows the drags and they save with a 200.
    clearLock();
    await refreshPipelineJobs(page);
    if (!(await sideBySide.isVisible())) {
      await page.locator(`button[aria-label^="align ULT"]`).first().click();
    }
    await sideBySide.click();
    await wordsLabel.waitFor({ state: "visible" });
    await expect(count).toHaveText(after);
    const patched = page.waitForResponse(
      (r) => r.request().method() === "PATCH" && r.url().includes(V6),
    );
    await dual.locator('button:has(svg[data-testid="CloseIcon"])').first().click();
    await gate.getByRole("button", { name: "Save", exact: true }).click();
    // The refusal rolled the cache back to the server's (aligned) row, so
    // saving the restored Clear unaligns words against it and asks again
    // (#1073; before, the cache kept the refused content and it did not ask).
    await page.getByRole("button", { name: "Save anyway", exact: true }).click();
    expect((await patched).status()).toBe(200);
  } finally {
    clearLock();
    if (bridged) {
      const cur = await get(V6);
      const split = await context.request.post(`${V6}/split`, {
        headers: { "x-csrf-token": csrf, "If-Match": String(cur.version) },
      });
      expect(split.status(), await split.text()).toBe(200);
    }
    for (const [path, orig] of [
      [V6, orig6],
      [V7, orig7],
    ] as const) {
      const cur = await get(path);
      if (cur.content_json === orig.content_json) continue;
      const put = await context.request.patch(path, {
        headers: { "x-csrf-token": csrf, "If-Match": String(cur.version) },
        data: {
          content: JSON.parse(orig.content_json),
          plain_text: orig.plain_text,
          alignment_intent: "alignment_edit",
        },
      });
      expect(put.status(), await put.text()).toBe(200);
    }
  }

  await context.close();
});

// #1073: a refused save left its optimistic content in the chapter cache, so
// after the aligner's Reset (which goes back to the server's alignment) a
// reopened aligner still showed the refused alignment as saved, and a refused
// text edit stayed on screen as if it had landed. The cache must go back to
// the server's row once the refusal arrives.
test("a refused panel Save, then Reset: reopening the aligner shows the server's alignment, not the refused one", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const { context, auth } = await newUserContext(browser, "s17-refused-reset");
  const csrf = await csrfToken(context.request);
  const page = await context.newPage();
  await page.clock.install();

  d1(`DELETE FROM pipeline_jobs WHERE job_id = '${JOB_ID}'`);
  const snap = await snapshotVerse(context.request);
  try {
    await openAligner(page);
    const saveBtn = page.getByRole("button", { name: `Save ${BV}`, exact: true });
    const resetBtn = page.getByRole("button", { name: "Reset", exact: true });
    const count = page
      .getByText(`${BV} words`, { exact: true })
      .locator("xpath=../..")
      .getByText(/^\d+ unaligned$/);

    const dragged = await dragAlignedWordToStrip(page);
    expect(dragged.after).not.toBe(dragged.before);

    lockChapter(auth.userId, "s17-refused-reset");
    const refused = page.waitForResponse(
      (r) => r.request().method() === "PATCH" && r.url().includes(VERSE_PATH),
    );
    await saveBtn.click();
    expect(await confirmUnalignIfAsked(page, refused)).toBe(409);
    await expect(page.getByText("chapter locked")).toBeVisible({ timeout: 15_000 });
    // The rollback has landed: the open panel reset to the server's row and
    // restored the drags from the crash draft.
    await expect(page.getByText("restored unsaved alignment")).toBeVisible({ timeout: 15_000 });
    await expect(count).toHaveText(dragged.after);

    // Reset goes back to the server's alignment.
    await resetBtn.click();
    await expect(count).toHaveText(dragged.before);

    // Close (clean, so no gate) and reopen: still the server's alignment.
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(saveBtn).toHaveCount(0);
    await page.locator(`button[aria-label^="align ${BV}"]`).first().click();
    await saveBtn.waitFor({ state: "visible" });
    await expect(count).toHaveText(dragged.before);
    await expect(resetBtn).toBeDisabled();
    expect(await crashDraftCount(page, DRAFT_KEY)).toBe(0);
  } finally {
    d1(`DELETE FROM pipeline_jobs WHERE job_id = '${JOB_ID}'`);
    await restoreVerse(context.request, csrf, snap);
  }

  await context.close();
});

test("a refused gate Save: the crash draft still brings the drags back, and Reset then shows the server's alignment", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const { context, auth } = await newUserContext(browser, "s17-refused-gate-reset");
  const csrf = await csrfToken(context.request);
  const page = await context.newPage();
  await page.clock.install();

  d1(`DELETE FROM pipeline_jobs WHERE job_id = '${JOB_ID}'`);
  const snap = await snapshotVerse(context.request);
  try {
    await openAligner(page);
    const saveBtn = page.getByRole("button", { name: `Save ${BV}`, exact: true });
    const resetBtn = page.getByRole("button", { name: "Reset", exact: true });
    const count = page
      .getByText(`${BV} words`, { exact: true })
      .locator("xpath=../..")
      .getByText(/^\d+ unaligned$/);

    const dragged = await dragAlignedWordToStrip(page);
    expect(dragged.after).not.toBe(dragged.before);
    await expect.poll(() => crashDraftCount(page, DRAFT_KEY), { timeout: 5_000 }).toBe(1);

    lockChapter(auth.userId, "s17-refused-gate-reset");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const gate = page.getByRole("dialog").filter({ hasText: "Unsaved alignment changes" });
    await expect(gate).toBeVisible();
    const refused = page.waitForResponse(
      (r) => r.request().method() === "PATCH" && r.url().includes(VERSE_PATH),
    );
    // The rollback's chapter re-read, sent after the 409.
    const reread = page.waitForResponse(
      (r) => r.request().method() === "GET" && r.url().endsWith(`/api/chapters/${BOOK}/${CHAPTER}`),
    );
    await gate.getByRole("button", { name: "Save", exact: true }).click();
    expect(await confirmUnalignIfAsked(page, refused)).toBe(409);
    await expect(page.getByText(/Your changes are kept in the aligner/)).toBeVisible();
    expect((await reread).ok()).toBe(true);
    await page.waitForTimeout(300); // let the applied row render

    // Reopen: the crash draft is still offered (the drags, unsaved).
    await page.locator(`button[aria-label^="align ${BV}"]`).first().click();
    await saveBtn.waitFor({ state: "visible" });
    await expect(count).toHaveText(dragged.after);
    await expect(resetBtn).toBeEnabled();

    // Reset discards them and lands on the server's alignment, which a
    // second reopen also shows.
    await resetBtn.click();
    await expect(count).toHaveText(dragged.before);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(saveBtn).toHaveCount(0);
    await page.locator(`button[aria-label^="align ${BV}"]`).first().click();
    await saveBtn.waitFor({ state: "visible" });
    await expect(count).toHaveText(dragged.before);
    await expect(resetBtn).toBeDisabled();
  } finally {
    d1(`DELETE FROM pipeline_jobs WHERE job_id = '${JOB_ID}'`);
    await restoreVerse(context.request, csrf, snap);
  }

  await context.close();
});

test("a refused text edit in the main column: the chapter cache goes back to the server's text", async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, auth } = await newUserContext(browser, "s17-refused-text");
  const page = await context.newPage();
  await page.clock.install();

  d1(`DELETE FROM pipeline_jobs WHERE job_id = '${JOB_ID}'`);
  // 6:3, not 6:2: the first test above leaves 6:2 with an unaligned text
  // node, and this case needs a fully aligned verse to start from. The edit
  // is refused, so nothing needs restoring.
  const TEXT_VERSE = 3;
  const textPath = `/api/verses/${BOOK}/${CHAPTER}/${TEXT_VERSE}/${BV}`;
  try {
    await page.goto(`/#/${BOOK}/${CHAPTER}/${TEXT_VERSE}`);
    const cell = page.locator(`[contenteditable="true"][data-find-cell="${CHAPTER}-${TEXT_VERSE}-${BV}"]`);
    await cell.waitFor({ timeout: 15_000 });
    const original = (await cell.textContent()) ?? "";
    expect(original.length).toBeGreaterThan(0);
    const alignBtn = page.locator(`button[aria-label^="align ${BV}"]`).first();
    await expect(alignBtn.locator('svg[data-testid="LinkOffIcon"]')).toHaveCount(0);

    lockChapter(auth.userId, "s17-refused-text");
    const marker = ` REFUSED1073-${Date.now()}`;
    await cell.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(marker, { delay: 20 });
    await expect(cell).toHaveText(original + marker);
    const refused = page.waitForResponse(
      (r) => r.request().method() === "PATCH" && r.url().includes(textPath),
    );
    await page.locator('button:has([data-testid="SaveIcon"])').first().click();
    expect((await refused).status()).toBe(409);
    await expect(page.getByText(/Edit dropped.*AI run.*mid-flight/i)).toBeVisible();

    // The typing stays on screen as an unsaved draft (drafts.ts), but the
    // chapter cache under it must hold the server's text again: the verse's
    // align button, which reads the cache's content, goes back to aligned
    // instead of showing the refused text's broken alignment.
    const readOnlyCell = page.locator(`[data-find-cell="${CHAPTER}-${TEXT_VERSE}-${BV}"]`).first();
    await expect(readOnlyCell).toHaveText(original + marker);
    await expect(readOnlyCell).toHaveAttribute("data-dirty", "true");
    await expect(alignBtn.locator('svg[data-testid="LinkOffIcon"]')).toHaveCount(0, { timeout: 10_000 });
    const server = (await (await context.request.get(textPath)).json()) as { plain_text: string };
    expect(server.plain_text).not.toContain(marker.trim());
  } finally {
    d1(`DELETE FROM pipeline_jobs WHERE job_id = '${JOB_ID}'`);
  }

  await context.close();
});

// Click through the "word will be unaligned" confirm if it opens before
// `done` settles (whether a drag trips it depends on the verse's other
// aligned copies of the word).
// The wait is bounded and the click happens only once the button is visible,
// so no click is left pending to hit a later save's confirm.
async function saveAnywayIfAsked(page: Page, done: Promise<unknown>): Promise<void> {
  const anyway = page.getByRole("button", { name: "Save anyway", exact: true });
  const asked = await Promise.race([
    done.then(() => false),
    anyway.waitFor({ state: "visible", timeout: 5_000 }).then(
      () => true,
      () => false,
    ),
  ]);
  if (asked) await anyway.click();
  await done;
}

// #1077: the refusal writes its crash draft after an open panel's one-time
// hydration read. Hold the gate Save's PATCH until the aligner is reopened,
// so the 409 lands under a panel that already read "no draft".
test("a refused gate Save whose 409 lands after the aligner reopened: the open panel shows the drags as unsaved", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const { context, auth } = await newUserContext(browser, "s17-refused-reopened");
  const csrf = await csrfToken(context.request);
  const page = await context.newPage();
  await page.clock.install();

  d1(`DELETE FROM pipeline_jobs WHERE job_id = '${JOB_ID}'`);
  const snap = await snapshotVerse(context.request);
  try {
    await openAligner(page);
    const saveBtn = page.getByRole("button", { name: `Save ${BV}`, exact: true });
    const resetBtn = page.getByRole("button", { name: "Reset", exact: true });
    const count = page
      .getByText(`${BV} words`, { exact: true })
      .locator("xpath=../..")
      .getByText(/^\d+ unaligned$/);

    const dragged = await dragAlignedWordToStrip(page);
    expect(dragged.after).not.toBe(dragged.before);
    await expect.poll(() => crashDraftCount(page, DRAFT_KEY), { timeout: 5_000 }).toBe(1);

    lockChapter(auth.userId, "s17-refused-reopened");
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route(
      (u) => u.pathname === VERSE_PATH,
      async (route) => {
        if (route.request().method() === "PATCH") await held;
        await route.fallback();
      },
    );
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const gate = page.getByRole("dialog").filter({ hasText: "Unsaved alignment changes" });
    await expect(gate).toBeVisible();
    const sent = page.waitForRequest((r) => r.method() === "PATCH" && r.url().includes(VERSE_PATH));
    await gate.getByRole("button", { name: "Save", exact: true }).click();
    await saveAnywayIfAsked(page, sent);
    await expect(saveBtn).toHaveCount(0);

    // Reopen while the PATCH is still held: the panel reads no crash draft.
    await page.locator(`button[aria-label^="align ${BV}"]`).first().click();
    await saveBtn.waitFor({ state: "visible" });
    await expect(count).toHaveText(dragged.after);

    const refused = page.waitForResponse(
      (r) => r.request().method() === "PATCH" && r.url().includes(VERSE_PATH),
    );
    // The rollback's chapter re-read, sent after the 409. Reset before it
    // lands would go back to the optimistic row, not the server's.
    const reread = page.waitForResponse(
      (r) => r.request().method() === "GET" && r.url().endsWith(`/api/chapters/${BOOK}/${CHAPTER}`),
    );
    release();
    expect((await refused).status()).toBe(409);
    await expect(page.getByText(/Your changes are kept in the aligner/)).toBeVisible();
    expect((await reread).ok()).toBe(true);
    await page.waitForTimeout(300); // let the applied row render

    // The open panel shows the drags as unsaved, over the server's alignment.
    await expect(resetBtn).toBeEnabled({ timeout: 15_000 });
    await expect(count).toHaveText(dragged.after);
    await resetBtn.click();
    await expect(count).toHaveText(dragged.before);
  } finally {
    d1(`DELETE FROM pipeline_jobs WHERE job_id = '${JOB_ID}'`);
    await restoreVerse(context.request, csrf, snap);
    await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => undefined);
  }

  await context.close();
});

// #1077 (second shape): Save A, then Save B while A is still queued. A lands,
// the lock begins before B reaches the server, and B is refused. A's row
// reset the open panel and dropped its pending record for B, so only the
// crash draft holds B's drags: the open panel must show them.
test("A saved, then B refused under a lock that began between them: the open panel shows B's drags as unsaved", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const { context, auth } = await newUserContext(browser, "s17-a-ok-b-refused");
  const csrf = await csrfToken(context.request);
  const page = await context.newPage();
  await page.clock.install();

  d1(`DELETE FROM pipeline_jobs WHERE job_id = '${JOB_ID}'`);
  const snap = await snapshotVerse(context.request);
  try {
    await openAligner(page);
    const saveBtn = page.getByRole("button", { name: `Save ${BV}`, exact: true });
    const resetBtn = page.getByRole("button", { name: "Reset", exact: true });
    const count = page
      .getByText(`${BV} words`, { exact: true })
      .locator("xpath=../..")
      .getByText(/^\d+ unaligned$/);

    // Hold A's PATCH; once released, send it, then lock the chapter before
    // B (queued behind A) is dispatched.
    let releaseA!: () => void;
    const heldA = new Promise<void>((r) => (releaseA = r));
    let patches = 0;
    await page.route(
      (u) => u.pathname === VERSE_PATH,
      async (route) => {
        if (route.request().method() !== "PATCH" || ++patches > 1) return route.fallback();
        await heldA;
        const resp = await route.fetch();
        lockChapter(auth.userId, "s17-a-ok-b-refused");
        await route.fulfill({ response: resp });
      },
    );

    const draggedA = await dragAlignedWordToStrip(page);
    expect(draggedA.after).not.toBe(draggedA.before);
    const sentA = page.waitForRequest((r) => r.method() === "PATCH" && r.url().includes(VERSE_PATH));
    await saveBtn.click();
    await saveAnywayIfAsked(page, sentA);

    const draggedB = await dragAlignedWordToStrip(page, "red");
    expect(draggedB.after, "the second drag must change the alignment").not.toBe(draggedB.before);
    await saveBtn.click();
    await saveAnywayIfAsked(page, expect(saveBtn).toBeDisabled());
    await expect(saveBtn).toBeDisabled();

    const okA = page.waitForResponse(
      (r) => r.request().method() === "PATCH" && r.url().includes(VERSE_PATH) && r.status() === 200,
    );
    const refusedB = page.waitForResponse(
      (r) => r.request().method() === "PATCH" && r.url().includes(VERSE_PATH) && r.status() === 409,
    );
    releaseA();
    await okA;
    await refusedB;
    await expect(page.getByText(/Your changes are kept in the aligner/)).toBeVisible();

    // B's drags are on screen and unsaved; Reset goes back to A, which saved.
    await expect(resetBtn).toBeEnabled({ timeout: 15_000 });
    await expect(count).toHaveText(draggedB.after);
    await resetBtn.click();
    await expect(count).toHaveText(draggedA.after);
  } finally {
    d1(`DELETE FROM pipeline_jobs WHERE job_id = '${JOB_ID}'`);
    await restoreVerse(context.request, csrf, snap);
    await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => undefined);
  }

  await context.close();
});
