import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { csrfToken, newUserContext } from "./helpers";

// S14 — Verse history stays readable on a locked book.
//
// The `v{N}` chip beside a ULT/UST line in the stacked (rows) view opens the
// verse's version history. It used to render only while the line was
// editable, so locking a book (PUT /api/books/:book/lock) hid it and nobody
// could read a locked book's edit history — even though the history GET is
// allowed on a locked book (api/src/bookLockGuard.ts lets every GET through).
//
// What this guards:
//   1. Unlocked: the chip shows, the dialog opens, and restore is offered
//      ("Switch to vN").
//   2. Locked: the chip still shows on both ULT and UST; the dialog loads the
//      version list, previews an older version, and diffs it against current,
//      but the restore button reads "Locked" and is disabled. No verse PATCH
//      fires while locked.
//
// Locking needs a lock admin (book_lock_admins, migration 0043), so this signs
// in as `deferredreward`. Every spec shares the seeded ZEC fixture, so the
// book is unlocked again in `finally` whatever happens.

const BOOK = "ZEC";
const CHAPTER = 4;
const VERSE = 6;

// One API edit to ULT so its history holds at least two versions. Appends a
// plain text node, which leaves every existing alignment milestone untouched.
async function editUlt(request: APIRequestContext, csrf: string): Promise<number> {
  const path = `/api/verses/${BOOK}/${CHAPTER}/${VERSE}/ULT`;
  const cur = await request.get(path);
  expect(cur.ok()).toBe(true);
  const row = (await cur.json()) as { version: number; plain_text: string; content_json: string };
  const content = JSON.parse(row.content_json) as { verseObjects: unknown[] };
  content.verseObjects.push({ type: "text", text: " [s14]" });
  const res = await request.patch(path, {
    headers: { "x-csrf-token": csrf, "If-Match": String(row.version) },
    data: { content, plain_text: `${row.plain_text} [s14]` },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { version: number }).version;
}

async function setLock(request: APIRequestContext, csrf: string, locked: boolean) {
  const path = `/api/books/${BOOK}/lock`;
  const opts = { headers: { "x-csrf-token": csrf }, data: { reason: "s14 test" } };
  const res = locked ? await request.put(path, opts) : await request.delete(path, opts);
  expect(res.status(), await res.text()).toBe(200);
  expect(((await res.json()) as { locked: boolean }).locked).toBe(locked);
}

// The stacked view's active line for one version: the block whose header
// caption reads "ULT"/"UST" and that holds that verse's editable cell. XPath
// returns ancestors in document order, so `.last()` is the innermost match.
function activeLine(page: Page, bibleVersion: "ULT" | "UST"): Locator {
  return page
    .locator(
      `xpath=//div[./div//span[normalize-space()="${bibleVersion}"] and .//*[@data-find-cell="${CHAPTER}-${VERSE}-${bibleVersion}"]]`,
    )
    .last();
}

function historyChip(page: Page, bibleVersion: "ULT" | "UST"): Locator {
  // The Tooltip's aria-label marks the verse-history chip apart from the note
  // cards' own "v1 — saved …" chips.
  return activeLine(page, bibleVersion).locator('.MuiChip-root[aria-label^="version history"]');
}

// Always a full page load: the app fetches book-lock state once on mount
// (web/src/hooks/useBookLocks), and a goto that differs only by hash would be
// a same-document navigation that never refetches it.
async function openVerse(page: Page) {
  await page.goto(`/#/${BOOK}/${CHAPTER}/${VERSE}`);
  await page.reload();
  await page.locator(`[data-find-cell="${CHAPTER}-${VERSE}-ULT"]`).first().waitFor({ timeout: 15_000 });
}

test("verse history chip + read-only dialog stay available on a locked book", async ({ browser }) => {
  const { context } = await newUserContext(browser, "deferredreward");
  const csrf = await csrfToken(context.request);
  const page = await context.newPage();

  try {
    await setLock(context.request, csrf, false);
    const current = await editUlt(context.request, csrf);
    expect(current).toBeGreaterThanOrEqual(2);
    const previous = current - 1;

    // 1. Unlocked: chip visible, dialog offers restore.
    await openVerse(page);
    await expect(historyChip(page, "ULT")).toHaveText(`v${current}`);
    await historyChip(page, "ULT").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Verse history")).toBeVisible();
    await expect(dialog.getByRole("button", { name: `Switch to v${previous}` })).toBeEnabled();
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();

    // 2. Locked: reload so the app picks up the lock.
    await setLock(context.request, csrf, true);
    const verseWrites: string[] = [];
    page.on("request", (req) => {
      if (req.method() !== "GET" && req.url().includes("/api/verses/")) {
        verseWrites.push(`${req.method()} ${req.url()}`);
      }
    });
    await openVerse(page);

    await expect(historyChip(page, "UST")).toBeVisible();
    await expect(historyChip(page, "ULT")).toHaveText(`v${current}`);
    await historyChip(page, "ULT").click();
    await expect(dialog.getByText("Verse history")).toBeVisible();
    await expect(dialog.getByText(/failed to load history/)).toHaveCount(0);

    // The dialog opens on the newest non-current version: its preview shows,
    // and it diffs against current (the appended "[s14]" is the only change).
    await expect(dialog.getByText(`preview of v${previous}`)).toBeVisible();
    await dialog.getByRole("button", { name: "diff vs current" }).click();
    await expect(dialog.getByText(`diff: v${previous} → v${current}`)).toBeVisible();

    const restore = dialog.getByRole("button", { name: "Locked" });
    await expect(restore).toBeVisible();
    await expect(restore).toBeDisabled();
    await expect(dialog.getByRole("button", { name: /^Switch to v/ })).toHaveCount(0);

    if (process.env.S14_SCREENSHOT) await page.screenshot({ path: process.env.S14_SCREENSHOT });

    await dialog.getByRole("button", { name: "Close" }).click();

    // UST's chip opens the same read-only dialog.
    await historyChip(page, "UST").click();
    await expect(dialog.getByText("Verse history")).toBeVisible();
    await expect(dialog.getByText(/failed to load history/)).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Locked" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Close" }).click();

    expect(verseWrites).toEqual([]);
  } finally {
    await setLock(context.request, csrf, false);
    await context.close();
  }
});
