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
//   5. (#1050) A refused or cancelled save leaves the reading line's verse-base
//      hold (#1060) in place while its edit is still on screen: saving the
//      kept edit after the verse moved must 409, never overwrite the change.
//      Once the edit goes away (Undo, typed back, an unfocused resync, gate
//      Discard), the pin goes too, so a new edit saves with a 200. A refusal
//      also frees "save, mark done, next" (its in-flight guard used to stay
//      set, so the button ignored clicks), and the "left N words unaligned"
//      notice appears only for a save that is actually queued.
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

// Unlock the book while the dialog is open and wait for the tab to learn it.
// The refocus fetch is throttled to one per 15 s, so keep refocusing until
// the line is editable again.
async function unlockAndLetItLand(o: Opened, request: APIRequestContext, csrf: string) {
  await setLock(request, csrf, false);
  const editableAgain = o.dialog.getByText("✎ editable").first();
  await expect
    .poll(
      async () => {
        await o.page.evaluate(() => window.dispatchEvent(new Event("focus")));
        return editableAgain.isVisible();
      },
      { timeout: 30_000, intervals: [1_000] },
    )
    .toBe(true);
}

type VerseRow = { version: number; plain_text: string; content_json: string };

async function serverVerse(request: APIRequestContext): Promise<VerseRow> {
  const res = await request.get(`/api/verses/${BOOK}/${CHAPTER}/${VERSE}/${BV}`);
  expect(res.ok()).toBe(true);
  return (await res.json()) as VerseRow;
}

// Write the verse over the API, as another editor (or a reimport) would.
async function putVerse(request: APIRequestContext, csrf: string, content: unknown, plain: string) {
  const cur = await serverVerse(request);
  const res = await request.patch(`/api/verses/${BOOK}/${CHAPTER}/${VERSE}/${BV}`, {
    headers: { "x-csrf-token": csrf, "If-Match": String(cur.version) },
    data: { content, plain_text: plain },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { version: number }).version;
}

const PIN_KEY = `verse:${BOOK}:${CHAPTER}:${VERSE}:${BV}`;
// drafts.ts's DEV-only test hook.
type PinDebugWindow = {
  __bePinDebug?: {
    peek: (key: string) => { version: number } | undefined;
    currentVersion: (key: string) => number | undefined;
  };
};

async function pinnedVersion(page: Page): Promise<number | undefined> {
  return page.evaluate((key) => (window as unknown as PinDebugWindow).__bePinDebug?.peek(key)?.version, PIN_KEY);
}

async function cachedVersion(page: Page): Promise<number | undefined> {
  return page.evaluate((key) => (window as unknown as PinDebugWindow).__bePinDebug?.currentVersion(key), PIN_KEY);
}

// Move the verse on the server (append a plain text node, leaving every
// alignment milestone alone), then wait until this tab's chapter cache holds
// the new version.
async function bumpVerse(page: Page, request: APIRequestContext, csrf: string, tag: string): Promise<number> {
  const cur = await serverVerse(request);
  const content = JSON.parse(cur.content_json) as { verseObjects: unknown[] };
  content.verseObjects.push({ type: "text", text: ` ${tag}` });
  const version = await putVerse(request, csrf, content, `${cur.plain_text} ${tag}`);
  await expect.poll(() => cachedVersion(page)).toBe(version);
  return version;
}

// "sent Sharezer" -> "Sharezer sent": swapping two aligned words trips the
// collateral-loss guard for ZEC 7:2 ULT, so the save parks on the "Words
// will be unaligned" confirm instead of enqueueing.
async function swapAlignedWords(line: Locator) {
  const original = (await line.textContent()) ?? "";
  expect(original).toContain("sent Sharezer");
  await line.evaluate((el, text) => {
    el.textContent = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, original.replace("sent Sharezer", "Sharezer sent"));
}

// Append a word to the line as typed input. It unaligns nothing that was
// aligned, so its save never asks for confirmation, but the new word itself
// is unaligned, so a queued save shows the "left 1 word unaligned" notice.
async function appendToLine(line: Locator, word: string) {
  await line.evaluate((el, w) => {
    el.textContent = `${el.textContent ?? ""} ${w}`;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, word);
}

// The next PATCH of the verse this page sends.
function nextVersePatch(page: Page) {
  return page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().includes(`/api/verses/${BOOK}/${CHAPTER}/${VERSE}/${BV}`),
    { timeout: 15_000 },
  );
}

// The ULT reading line's buttons, and the unalign confirm.
function lineControls(o: Opened) {
  const confirm = o.page.getByRole("dialog").filter({ hasText: "will be unaligned" });
  return {
    save: o.lineBox.getByRole("button", { name: `Save ${BV}`, exact: true }),
    undo: o.lineBox.getByRole("button", { name: "Undo", exact: true }),
    confirm,
    saveAnyway: confirm.getByRole("button", { name: "Save anyway" }),
    cancel: confirm.getByRole("button", { name: "Cancel" }),
  };
}

// Records every "This edit left N word(s) unaligned" / "marks were restored"
// notice the page shows. The toast slot holds one message, so a later toast
// replaces it; this still sees one that was on screen only briefly.
async function watchSaveNotices(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __s18Notices?: string[]; __s18NoticeObserver?: MutationObserver };
    w.__s18NoticeObserver?.disconnect();
    const seen: string[] = [];
    w.__s18Notices = seen;
    const re = /This edit left \d+ words? unaligned|Paragraph and poetry marks were restored/;
    const observer = new MutationObserver(() => {
      const m = document.body.textContent?.match(re);
      if (m && seen[seen.length - 1] !== m[0]) seen.push(m[0]);
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    w.__s18NoticeObserver = observer;
  });
}
async function saveNotices(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __s18Notices?: string[] }).__s18Notices ?? []);
}

// Park every IndexedDB read of the drafts store until releaseDraftReads: the
// success event is held back from the idb wrapper and redispatched later. This
// stops a save inside saveVerseDraft's draft lookup, so a book lock can land
// exactly there (the #1046 draft-lookup race) without any timing luck.
async function holdDraftReads(page: Page) {
  await page.evaluate(() => {
    type Held = { held: (() => void)[]; origGet: IDBObjectStore["get"] };
    const w = window as unknown as { __s18DraftReads?: Held };
    const origGet = IDBObjectStore.prototype.get;
    const state: Held = { held: [], origGet };
    w.__s18DraftReads = state;
    IDBObjectStore.prototype.get = function (this: IDBObjectStore, query: IDBValidKey | IDBKeyRange) {
      const req = origGet.call(this, query);
      if (this.name === "drafts") {
        let released = false;
        req.addEventListener("success", (e) => {
          if (!released) e.stopImmediatePropagation();
        });
        state.held.push(() => {
          released = true;
          req.dispatchEvent(new Event("success"));
        });
      }
      return req;
    };
  });
}
async function heldDraftReads(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as unknown as { __s18DraftReads?: { held: unknown[] } }).__s18DraftReads?.held.length ?? 0,
  );
}
async function releaseDraftReads(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __s18DraftReads?: { held: (() => void)[]; origGet: IDBObjectStore["get"] } };
    const state = w.__s18DraftReads;
    if (!state) return;
    IDBObjectStore.prototype.get = state.origGet;
    for (const release of state.held.splice(0)) release();
  });
}

test("a reading-line save refused at the unalign confirm keeps its pin while the edit is on screen; after Undo and an unlock, a new edit after the verse moved saves with a 200", async ({
  browser,
}) => {
  test.setTimeout(120_000); // two book-lock refocus throttles
  const { context } = await newUserContext(browser, "deferredreward");
  const csrf = await csrfToken(context.request);
  const page = await context.newPage();
  const original = await serverVerse(context.request);
  const stamp = Date.now();

  try {
    await setLock(context.request, csrf, false);
    const o = await openDual(page);
    const { line } = o;
    const { save, undo, confirm, saveAnyway } = lineControls(o);
    await watchSaveNotices(page);
    expect(await pinnedVersion(page)).toBeUndefined();

    await swapAlignedWords(line);
    expect(await pinnedVersion(page)).toBe(original.version); // held from the first keystroke
    await save.click();
    await expect(saveAnyway).toBeVisible();
    await lockAndLetItLand(o, context.request, csrf);
    await saveAnyway.click();
    await expect(page.getByText(/book is locked.*not saved/i)).toBeVisible();
    await expect(confirm).toHaveCount(0);
    // The edit is still on screen, so its base stays pinned...
    await expect(undo).toBeEnabled();
    expect(await pinnedVersion(page)).toBe(original.version);
    // ...and no notice claimed the save went ahead.
    expect(await saveNotices(page)).toEqual([]);

    // Dropping the edit releases the pin: nothing was queued, so no outbox
    // exit ever would.
    await undo.click();
    await expect.poll(() => pinnedVersion(page)).toBeUndefined();

    // Unlock, and let the verse move on the server (another editor, or the
    // reimport the lock was for).
    await unlockAndLetItLand(o, context.request, csrf);
    await bumpVerse(page, context.request, csrf, `[s18-${stamp}]`);
    await expect(line).toContainText(`[s18-${stamp}]`);

    // A new edit saves against the moved version: 200, not a 409 from a
    // leaked pin of the version before the lock.
    await appendToLine(line, `AFTER-${stamp}`);
    const patched = nextVersePatch(page);
    await save.click();
    expect((await patched).status()).toBe(200);
    await expect(undo).toBeDisabled();
    await expect.poll(async () => (await serverVerse(context.request)).plain_text).toContain(`AFTER-${stamp}`);
    await expect.poll(() => pinnedVersion(page)).toBeUndefined(); // released by the landed save's exit
    // The queued save's own notice does show, once.
    await expect.poll(async () => (await saveNotices(page)).length).toBe(1);
    expect((await saveNotices(page))[0]).toMatch(/^This edit left \d+ words? unaligned$/);
  } finally {
    await setLock(context.request, csrf, false);
    await putVerse(context.request, csrf, JSON.parse(original.content_json), original.plain_text);
    await context.close();
  }
});

test("a reading-line save refused at the unalign confirm whose edit is kept: saving it after an unlock and a server change is a 409, never an overwrite", async ({
  browser,
}) => {
  test.setTimeout(120_000); // two book-lock refocus throttles
  const { context } = await newUserContext(browser, "deferredreward");
  const csrf = await csrfToken(context.request);
  const page = await context.newPage();
  const original = await serverVerse(context.request);
  const tag = `[s18-${Date.now()}]`;

  try {
    await setLock(context.request, csrf, false);
    const o = await openDual(page);
    const { line } = o;
    const { save, undo, saveAnyway } = lineControls(o);

    await swapAlignedWords(line);
    await save.click();
    await expect(saveAnyway).toBeVisible();
    await lockAndLetItLand(o, context.request, csrf);
    await saveAnyway.click();
    await expect(page.getByText(/book is locked.*not saved/i)).toBeVisible();
    await expect(undo).toBeEnabled(); // the edit is kept

    // Unlocked, the translator goes back into the line (so it is not resynced
    // under the caret) while the verse moves on the server.
    await unlockAndLetItLand(o, context.request, csrf);
    await line.click();
    await bumpVerse(page, context.request, csrf, tag);
    await expect(line).toContainText("Sharezer sent");
    await expect(line).not.toContainText(tag);
    expect(await pinnedVersion(page)).toBe(original.version);

    // Saving the kept edit sends the version it was made against, so the
    // server refuses it instead of losing the change.
    await save.click();
    await expect(saveAnyway).toBeVisible();
    const patched = nextVersePatch(page);
    await saveAnyway.click();
    const res = await patched;
    expect(res.request().headers()["if-match"]).toBe(String(original.version));
    expect(res.status()).toBe(409);
    const after = (await serverVerse(context.request)).plain_text;
    expect(after).toContain(tag);
    expect(after).not.toContain("Sharezer sent");
  } finally {
    await setLock(context.request, csrf, false);
    await putVerse(context.request, csrf, JSON.parse(original.content_json), original.plain_text);
    await context.close();
  }
});

test("a reading-line save refused during its draft lookup keeps its pin, shows no 'left unaligned' notice, and frees 'save, mark done, next' once unlocked", async ({
  browser,
}) => {
  test.setTimeout(120_000); // two book-lock refocus throttles
  const { context } = await newUserContext(browser, "deferredreward");
  const csrf = await csrfToken(context.request);
  const page = await context.newPage();
  const original = await serverVerse(context.request);
  const stamp = Date.now();

  try {
    await setLock(context.request, csrf, false);
    const o = await openDual(page);
    const { dialog, line, verseWrites } = o;
    const { undo } = lineControls(o);
    const doneNext = page.getByRole("button", { name: "Save both, mark verse done, next verse" });
    const here = dialog.getByText(`${BOOK} ${CHAPTER}:${VERSE}`, { exact: true });
    await watchSaveNotices(page);
    await expect(here).toBeVisible();

    // The button's save stops inside its draft lookup; the lock lands there;
    // then the lookup finishes and the save reaches its commit check.
    await appendToLine(line, `RACE-${stamp}`);
    await holdDraftReads(page);
    await doneNext.click();
    await expect.poll(() => heldDraftReads(page)).toBeGreaterThan(0);
    await lockAndLetItLand(o, context.request, csrf);
    await releaseDraftReads(page);
    await expect(page.getByText(/book is locked.*not saved/i)).toBeVisible();
    await expect(here).toBeVisible(); // not marked-and-moved
    await expect(undo).toBeEnabled();
    expect(await pinnedVersion(page)).toBe(original.version);
    expect(await saveNotices(page)).toEqual([]);
    expect(verseWrites).toEqual([]);
    expect(await outboxVerseOps(page)).toBe(0);

    // Undo drops the edit and its pin.
    await undo.click();
    await expect.poll(() => pinnedVersion(page)).toBeUndefined();

    // Unlocked again, the button saves, marks the verse done and moves on.
    await unlockAndLetItLand(o, context.request, csrf);
    await expect(doneNext).toBeEnabled();
    await appendToLine(line, `DONE-${stamp}`);
    const patched = nextVersePatch(page);
    const marked = page.waitForResponse(
      (r) => r.request().method() === "PATCH" && r.url().includes(`/api/chapters/${BOOK}/${CHAPTER}/${VERSE}/lanes/text`),
    );
    await doneNext.click();
    await expect(dialog.getByText(`${BOOK} ${CHAPTER}:${VERSE + 1}`, { exact: true })).toBeVisible();
    expect((await patched).status()).toBe(200);
    expect((await marked).ok()).toBe(true);
  } finally {
    await releaseDraftReads(page).catch(() => {});
    await setLock(context.request, csrf, false);
    // Put the verse and its Text-lane check back for the other specs.
    await context.request.patch(`/api/chapters/${BOOK}/${CHAPTER}/${VERSE}/lanes/text`, {
      headers: { "x-csrf-token": csrf },
      data: { checked: false },
    });
    await putVerse(context.request, csrf, JSON.parse(original.content_json), original.plain_text);
    await context.close();
  }
});

test('a "save, mark done, next" refused at the unalign confirm leaves the button working once the book is unlocked', async ({
  browser,
}) => {
  test.setTimeout(120_000); // two book-lock refocus throttles
  const { context } = await newUserContext(browser, "deferredreward");
  const csrf = await csrfToken(context.request);
  const page = await context.newPage();
  const original = await serverVerse(context.request);
  const stamp = Date.now();

  try {
    await setLock(context.request, csrf, false);
    const o = await openDual(page);
    const { dialog, line } = o;
    const { undo, saveAnyway } = lineControls(o);
    const doneNext = page.getByRole("button", { name: "Save both, mark verse done, next verse" });
    const here = dialog.getByText(`${BOOK} ${CHAPTER}:${VERSE}`, { exact: true });

    // The button's chain parks on the unalign confirm, the lock lands, and
    // Save anyway is refused.
    await expect(here).toBeVisible();
    await swapAlignedWords(line);
    await doneNext.click();
    await expect(saveAnyway).toBeVisible();
    await lockAndLetItLand(o, context.request, csrf);
    await saveAnyway.click();
    await expect(page.getByText(/book is locked.*not saved/i)).toBeVisible();
    await expect(here).toBeVisible();
    await undo.click();

    // Unlocked again, the button saves, marks the verse done and moves on.
    await unlockAndLetItLand(o, context.request, csrf);
    await expect(doneNext).toBeEnabled();
    await appendToLine(line, `DONE-${stamp}`);
    const patched = nextVersePatch(page);
    const marked = page.waitForResponse(
      (r) => r.request().method() === "PATCH" && r.url().includes(`/api/chapters/${BOOK}/${CHAPTER}/${VERSE}/lanes/text`),
    );
    await doneNext.click();
    await expect(dialog.getByText(`${BOOK} ${CHAPTER}:${VERSE + 1}`, { exact: true })).toBeVisible();
    expect((await patched).status()).toBe(200);
    expect((await marked).ok()).toBe(true);
  } finally {
    await setLock(context.request, csrf, false);
    await context.request.patch(`/api/chapters/${BOOK}/${CHAPTER}/${VERSE}/lanes/text`, {
      headers: { "x-csrf-token": csrf },
      data: { checked: false },
    });
    await putVerse(context.request, csrf, JSON.parse(original.content_json), original.plain_text);
    await context.close();
  }
});

test("a cancelled unalign confirm keeps the pin while the edit is kept (a later save after a server change 409s) and releases it however the edit goes away", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const { context } = await newUserContext(browser, "deferredreward");
  const csrf = await csrfToken(context.request);
  const page = await context.newPage();
  const original = await serverVerse(context.request);
  const stamp = Date.now();

  try {
    await setLock(context.request, csrf, false);
    const o = await openDual(page);
    const { line } = o;
    const { save, undo, confirm, saveAnyway, cancel } = lineControls(o);

    // Swap two aligned words, Save, and Cancel the unalign confirm: the edit
    // stays on screen with its pin, and no notice claims it was saved.
    const keepAnEdit = async () => {
      await watchSaveNotices(page);
      const base = await cachedVersion(page);
      await swapAlignedWords(line);
      await save.click();
      await expect(cancel).toBeVisible();
      await cancel.click();
      await expect(confirm).toHaveCount(0);
      await expect(undo).toBeEnabled();
      expect(await pinnedVersion(page)).toBe(base);
      expect(await saveNotices(page)).toEqual([]);
    };
    const newEditSaves = async (word: string) => {
      await appendToLine(line, word);
      const patched = nextVersePatch(page);
      await save.click();
      expect((await patched).status()).toBe(200);
      await expect(undo).toBeDisabled();
      await expect.poll(() => pinnedVersion(page)).toBeUndefined();
      // That save's own "left 1 word unaligned" notice must expire (8 s)
      // before the next keepAnEdit watches for early notices.
      await expect(page.getByText(/This edit left \d+ words? unaligned/)).toHaveCount(0, { timeout: 15_000 });
    };

    // 1. Undo.
    await keepAnEdit();
    await undo.click();
    await expect.poll(() => pinnedVersion(page)).toBeUndefined();
    await bumpVerse(page, context.request, csrf, `[s18a-${stamp}]`);
    await expect(line).toContainText(`[s18a-${stamp}]`);
    await newEditSaves(`A-${stamp}`);

    // 2. Typed back by hand: the line goes clean on input.
    await keepAnEdit();
    await line.evaluate((el) => {
      el.textContent = (el.textContent ?? "").replace("Sharezer sent", "sent Sharezer");
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await expect(undo).toBeDisabled();
    await expect.poll(() => pinnedVersion(page)).toBeUndefined();

    // 3. Replaced by a resync from the server while the line is not focused.
    await keepAnEdit();
    await bumpVerse(page, context.request, csrf, `[s18c-${stamp}]`);
    await expect(line).toContainText(`[s18c-${stamp}]`);
    await expect(undo).toBeDisabled();
    await expect.poll(() => pinnedVersion(page)).toBeUndefined();
    await newEditSaves(`C-${stamp}`);

    // 4. Kept: the translator goes back into the line while the verse moves;
    //    saving the kept edit sends the version it was made against and 409s.
    const kept = await serverVerse(context.request);
    await expect.poll(() => cachedVersion(page)).toBe(kept.version);
    await keepAnEdit();
    await line.click();
    await bumpVerse(page, context.request, csrf, `[s18d-${stamp}]`);
    await expect(line).not.toContainText(`[s18d-${stamp}]`);
    await save.click();
    await expect(saveAnyway).toBeVisible();
    const patched = nextVersePatch(page);
    await saveAnyway.click();
    const res = await patched;
    expect(res.request().headers()["if-match"]).toBe(String(kept.version));
    expect(res.status()).toBe(409);
    expect((await serverVerse(context.request)).plain_text).toContain(`[s18d-${stamp}]`);
  } finally {
    await putVerse(context.request, csrf, JSON.parse(original.content_json), original.plain_text);
    await context.close();
  }
});

test("a reading-line save refused at the close gate keeps its pin, and Discard at the gate releases it", async ({
  browser,
}) => {
  test.setTimeout(90_000); // one book-lock refocus throttle
  const { context } = await newUserContext(browser, "deferredreward");
  const csrf = await csrfToken(context.request);
  const page = await context.newPage();
  const original = await serverVerse(context.request);
  const stamp = Date.now();

  try {
    await setLock(context.request, csrf, false);
    const o = await openDual(page);
    const { dialog, line } = o;
    const { undo } = lineControls(o);
    const close = dialog.locator('button:has(svg[data-testid="CloseIcon"])').first();
    const gate = page.getByRole("dialog").filter({ hasText: "Unsaved changes" });

    await appendToLine(line, `GATE-${stamp}`);
    await lockAndLetItLand(o, context.request, csrf);
    await close.click();
    await gate.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(/book is locked.*not saved/i)).toBeVisible();
    await expect(undo).toBeEnabled();
    expect(await pinnedVersion(page)).toBe(original.version);

    await close.click();
    await gate.getByRole("button", { name: "Discard", exact: true }).click();
    await expect(line).toHaveCount(0);
    await expect.poll(() => pinnedVersion(page)).toBeUndefined();
  } finally {
    await setLock(context.request, csrf, false);
    await context.close();
  }
});
