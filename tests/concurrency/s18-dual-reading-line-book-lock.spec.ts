import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { csrfToken, newUserContext } from "./helpers";

// S18 — issue #1046 (follow-up to #943): a book lock that lands while the
// side-by-side (dual) aligner is open left its reading line editable. Its
// save went through saveVerseDraft into the outbox, which drops every write
// on a locked book without a trace (outbox.ts noopOp, set up by Shell's
// setReadOnlyReason("bookLocked")). The line then read as saved, and the
// edit was gone after a refresh.
//
// What this guards:
//   1. Once the lock lands, the reading line is not editable: no
//      contenteditable, typing changes nothing, no Save button.
//   2. An edit typed BEFORE the lock stays visibly unsaved: Undo is offered,
//      and saving it through the close gate is refused with a toast, leaves
//      the dialog open and the text in place (never "saved").
//   3. No verse write reaches the network or the outbox, and the server
//      text never picks up either edit.
//   4. A save already under way when the lock lands (here: parked on the
//      "Words will be unaligned" confirm) is refused at the point of commit
//      too: "Save anyway" shows the toast and the line stays dirty.
//
// A chapter (pipeline) lock is s9 check (b)'s job: there the reading line
// stays reachable and the server refuses the save with a toast. Locking a
// book needs a lock admin, so this signs in as `deferredreward`; the book is
// unlocked again in `finally` whatever happens (every spec shares ZEC).

const BOOK = "ZEC";
const CHAPTER = 7;
const VERSE = 2;
const BV = "ULT";

async function setLock(request: APIRequestContext, csrf: string, locked: boolean) {
  const path = `/api/books/${BOOK}/lock`;
  const opts = { headers: { "x-csrf-token": csrf }, data: { reason: "s18 test" } };
  const res = locked ? await request.put(path, opts) : await request.delete(path, opts);
  expect(res.status(), await res.text()).toBe(200);
  expect(((await res.json()) as { locked: boolean }).locked).toBe(locked);
}

async function serverPlain(request: APIRequestContext): Promise<string> {
  const res = await request.get(`/api/verses/${BOOK}/${CHAPTER}/${VERSE}/${BV}`);
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { plain_text: string }).plain_text;
}

async function outboxVerseOps(page: Page): Promise<number> {
  return page.evaluate(
    async ({ book, chapter, verse, bv }) => {
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const req = indexedDB.open("bible-editor-outbox", 1);
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      const ops = await new Promise<
        { target: { kind: string; book?: string; chapter?: number; verse?: number; bibleVersion?: string } }[]
      >((res, rej) => {
        const req = db.transaction("ops", "readonly").objectStore("ops").getAll();
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      db.close();
      return ops.filter(
        (o) =>
          o.target.kind === "verse" &&
          o.target.book === book &&
          o.target.chapter === chapter &&
          o.target.verse === verse &&
          o.target.bibleVersion === bv,
      ).length;
    },
    { book: BOOK, chapter: CHAPTER, verse: VERSE, bv: BV },
  );
}

type Opened = {
  page: Page;
  dialog: Locator;
  editable: Locator;
  line: Locator;
  lineBox: Locator;
  verseWrites: string[];
};

// Open the dual aligner on BOOK CHAPTER:VERSE and tag the ULT reading line
// (left = first) so it stays addressable once it is no longer
// contenteditable. React leaves attributes it didn't set alone.
async function openDual(page: Page): Promise<Opened> {
  await page.goto(`/#/${BOOK}/${CHAPTER}/${VERSE}`);
  await page.reload();
  await page
    .locator(`[data-find-cell="${CHAPTER}-${VERSE}-${BV}"]`)
    .first()
    .waitFor({ timeout: 15_000 });
  await page.locator(`button[aria-label^="align ${BV}"]`).first().click();
  const sideBySide = page.locator("button", { hasText: "Side-by-side" }).first();
  await sideBySide.waitFor({ state: "visible" });
  await sideBySide.click();
  const dialog = page.getByRole("dialog").filter({ hasText: "reading text" });
  const editable = dialog.locator('[contenteditable="true"]:visible');
  await editable.first().waitFor({ state: "visible" });
  await editable.first().evaluate((el) => el.setAttribute("data-s18-line", "ULT"));
  const line = dialog.locator('[data-s18-line="ULT"]');
  const verseWrites: string[] = [];
  page.on("request", (req) => {
    if (req.method() !== "GET" && req.url().includes("/api/verses/")) {
      verseWrites.push(`${req.method()} ${req.url()}`);
    }
  });
  return { page, dialog, editable, line, lineBox: line.locator(".."), verseWrites };
}

// Lock the book while the dialog is open. The tab learns about it on a
// window refocus (useBookLocks), which is throttled to one successful fetch
// per 15 s, so wait out the mount fetch's window first.
async function lockAndLetItLand(o: Opened, request: APIRequestContext, csrf: string) {
  await setLock(request, csrf, true);
  await o.page.waitForTimeout(15_500);
  await o.page.evaluate(() => window.dispatchEvent(new Event("focus")));
  // #943's aligner note is the sync point: the lock has reached the dialog.
  // Page-wide, not dialog-scoped: while the unalign confirm is open the
  // aligner dialog is aria-hidden, so a role query can't see into it.
  await expect(o.page.getByText("🔒 book locked").first()).toBeVisible();
}

test("dual aligner reading line locks when a book lock lands, and a pre-lock edit is never shown as saved", async ({
  browser,
}) => {
  test.setTimeout(90_000); // includes the 15 s book-lock refocus throttle
  const { context } = await newUserContext(browser, "deferredreward");
  const csrf = await csrfToken(context.request);
  const page = await context.newPage();
  const stamp = Date.now();
  const preLock = `PRELOCK-${stamp}`;
  const postLock = `POSTLOCK-${stamp}`;

  try {
    await setLock(context.request, csrf, false);
    const o = await openDual(page);
    const { dialog, editable, line, lineBox, verseWrites } = o;

    // An edit typed before the lock lands: dirty, not saved.
    await line.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(` ${preLock}`);
    await expect(lineBox.getByRole("button", { name: `Save ${BV}`, exact: true })).toBeEnabled();

    await lockAndLetItLand(o, context.request, csrf);

    // 1. The reading line is locked.
    await expect(editable).toHaveCount(0);
    await expect(lineBox.getByRole("button", { name: `Save ${BV}`, exact: true })).toHaveCount(0);
    await line.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(` ${postLock}`);
    await expect(line).not.toContainText(postLock);

    // 2. The pre-lock edit stays visibly unsaved and can be undone.
    await expect(line).toContainText(preLock);
    const undo = lineBox.getByRole("button", { name: "Undo", exact: true });
    await expect(undo).toBeEnabled();

    // Saving it through the close gate is refused out loud.
    await dialog.locator('button:has(svg[data-testid="CloseIcon"])').first().click();
    const gate = page.getByRole("dialog").filter({ hasText: "Unsaved changes" });
    await gate.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(/book is locked.*not saved/i)).toBeVisible();
    await expect(gate).toHaveCount(0);
    await expect(line).toBeVisible(); // the aligner did not close
    await expect(line).toContainText(preLock);
    await expect(undo).toBeEnabled();

    // 3. Nothing was written anywhere.
    await page.waitForTimeout(500);
    expect(verseWrites).toEqual([]);
    expect(await outboxVerseOps(page)).toBe(0);
    const plain = await serverPlain(context.request);
    expect(plain).not.toContain(preLock);
    expect(plain).not.toContain(postLock);

    // Undo clears it; the aligner then closes without a prompt.
    await undo.click();
    await expect(line).not.toContainText(preLock);
    await dialog.locator('button:has(svg[data-testid="CloseIcon"])').first().click();
    await expect(line).toHaveCount(0);
    await expect(gate).toHaveCount(0);
  } finally {
    await setLock(context.request, csrf, false);
    await context.close();
  }
});

test("a reading-line save parked on the unalign confirm is refused if the book lock lands before Save anyway", async ({
  browser,
}) => {
  test.setTimeout(90_000); // includes the 15 s book-lock refocus throttle
  const { context } = await newUserContext(browser, "deferredreward");
  const csrf = await csrfToken(context.request);
  const page = await context.newPage();

  try {
    await setLock(context.request, csrf, false);
    const o = await openDual(page);
    const { dialog, line, lineBox, verseWrites } = o;
    const before = await serverPlain(context.request);

    // Swapping two aligned words ("sent Sharezer" -> "Sharezer sent") trips
    // the collateral-loss guard for ZEC 7:2 ULT, so the save parks on the
    // "Words will be unaligned" confirm instead of enqueueing.
    const original = (await line.textContent()) ?? "";
    expect(original).toContain("sent Sharezer");
    const swapped = original.replace("sent Sharezer", "Sharezer sent");
    await line.evaluate((el, text) => {
      el.textContent = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, swapped);
    await lineBox.getByRole("button", { name: `Save ${BV}`, exact: true }).click();
    const confirm = page.getByRole("dialog").filter({ hasText: "will be unaligned" });
    await expect(confirm.getByRole("button", { name: "Save anyway" })).toBeVisible();

    // The lock lands while the confirm is open.
    await lockAndLetItLand(o, context.request, csrf);

    await confirm.getByRole("button", { name: "Save anyway" }).click();
    await expect(page.getByText(/book is locked.*not saved/i)).toBeVisible();
    await expect(confirm).toHaveCount(0);
    await expect(dialog.getByText("🔒 book locked").first()).toBeVisible(); // aligner still open
    await expect(line).toContainText("Sharezer sent");
    const undo = lineBox.getByRole("button", { name: "Undo", exact: true });
    await expect(undo).toBeEnabled(); // still dirty, not "saved"

    await page.waitForTimeout(500);
    expect(verseWrites).toEqual([]);
    expect(await outboxVerseOps(page)).toBe(0);
    expect(await serverPlain(context.request)).toBe(before);

    await undo.click();
    await expect(line).toContainText("sent Sharezer");
  } finally {
    await setLock(context.request, csrf, false);
    await context.close();
  }
});
