import { expect, test, type Page } from "@playwright/test";
import {
  fetchChapter,
  gotoVerse,
  newUserContext,
  openNoteEditor,
  saveNote,
  waitForServerNote,
} from "./helpers";

// S21 — issue #1092: type in a note without saving, then move it to another
// verse with its reference chip. The move's PATCH carries only the verse
// fields, so its 200 must not clear the note's draft: until Save, the typed
// text has to stay in IndexedDB (crash-safe) and the status bar has to say
// it is unsaved. A second case covers typing while a Save is in flight: that
// newer typing must survive the Save's 200 too.

async function readRowDraft(page: Page, key: string) {
  return page.evaluate(async (k) => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const req = indexedDB.open("bible-editor-drafts", 1);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const rec = await new Promise<
      { payload?: { patch?: { note?: string } }; expectedVersion?: number; meta?: { verse?: number } } | undefined
    >((res, rej) => {
      const req = db.transaction("drafts").objectStore("drafts").get(k);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    db.close();
    return rec
      ? { note: rec.payload?.patch?.note ?? null, expectedVersion: rec.expectedVersion, verse: rec.meta?.verse }
      : null;
  }, key);
}

// Status + attempts of every queued op, for waiting until a failed attempt
// has been recorded (the op is back to pending, not mid-request).
async function outboxOps(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const req = indexedDB.open("bible-editor-outbox");
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    if (!db.objectStoreNames.contains("ops")) {
      db.close();
      return [];
    }
    const all = await new Promise<{ status: string; attempts: number }[]>((res, rej) => {
      const req = db.transaction("ops").objectStore("ops").getAll();
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    db.close();
    return all.map((o) => `${o.status}:${o.attempts}`);
  });
}

async function outboxCount(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const req = indexedDB.open("bible-editor-outbox");
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    if (!db.objectStoreNames.contains("ops")) {
      db.close();
      return 0;
    }
    const n = await new Promise<number>((res, rej) => {
      const req = db.transaction("ops").objectStore("ops").count();
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    db.close();
    return n;
  });
}

// Poll until `check` holds, then require it to keep holding for ~1s: on the
// buggy path the draft exists for a few ms after the 200 before the clear
// deletes it, so a single successful read would not prove it survived.
async function expectStays(check: () => Promise<boolean>, message: string) {
  await expect.poll(check, { message, timeout: 10_000 }).toBe(true);
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 200));
    expect(await check(), message).toBe(true);
  }
}

test("moving a note with unsaved typing keeps its draft until Save", async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, auth } = await newUserContext(browser, "move1092");
  const page = await context.newPage();
  const chap = await fetchChapter(context.request, auth.token, "ZEC", 8);
  const row = chap.tn.find((r) => r.verse === 3 && r.ref_raw === "8:3");
  expect(row, "ZEC 8:3 needs a tn row").toBeTruthy();
  const id = row!.id;
  const key = `row:tn:ZEC:${id}`;

  await gotoVerse(page, "ZEC", 8, 3);
  const textarea = await openNoteEditor(page, id);
  const typed = " MOVE1092";
  await textarea.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(typed, { delay: 40 });
  await expect.poll(async () => (await readRowDraft(page, key))?.note ?? "").toContain(typed.trim());

  // Move the note to v5 through the reference chip's menu, then wait for the
  // move to land on the server and leave the outbox.
  await page.locator(`[data-note-id="${id}"] .MuiChip-root`).filter({ hasText: "8:3" }).click();
  await page.getByRole("menuitem", { name: "v5", exact: true }).click();
  await expect
    .poll(async () => (await fetchChapter(context.request, auth.token, "ZEC", 8)).tn.find((r) => r.id === id)?.verse)
    .toBe(5);
  await expect.poll(() => outboxCount(page)).toBe(0);
  const server = (await fetchChapter(context.request, auth.token, "ZEC", 8)).tn.find((r) => r.id === id)!;
  expect(server.note ?? "", "the move must not carry the typing").not.toContain(typed.trim());

  await expectStays(async () => {
    const d = await readRowDraft(page, key);
    return !!d && (d.note ?? "").includes(typed.trim()) && d.expectedVersion === server.version && d.verse === 5;
  }, "the typed text must stay in the draft store, at the moved row's version and verse");
  await expect(page.getByText(/^1 unsaved$/).first()).toBeVisible();

  // Save stores the typing and clears the draft.
  await saveNote(page, id);
  await waitForServerNote(context.request, auth.token, "ZEC", 8, id, (n) => (n ?? "").includes(typed.trim()));
  await expect.poll(() => readRowDraft(page, key)).toBeNull();
  await context.close();
});

test("typing while a note's Save is in flight keeps that typing in the draft store", async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, auth } = await newUserContext(browser, "inflight1092");
  const page = await context.newPage();
  const chap = await fetchChapter(context.request, auth.token, "ZEC", 8);
  const row = chap.tn.find((r) => r.verse === 4 && r.ref_raw === "8:4");
  expect(row, "ZEC 8:4 needs a tn row").toBeTruthy();
  const id = row!.id;
  const key = `row:tn:ZEC:${id}`;

  // Hold this row's PATCH for 1.5s so the second burst of typing lands while
  // the Save is in flight.
  await page.route((url) => url.pathname === `/api/rows/tn/${id}`, async (route) => {
    if (route.request().method() === "PATCH") await new Promise((r) => setTimeout(r, 1_500));
    await route.continue();
  });

  await gotoVerse(page, "ZEC", 8, 4);
  const textarea = await openNoteEditor(page, id);
  const first = " FIRST1092";
  const second = " SECOND1092";
  await textarea.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(first, { delay: 30 });
  await expect.poll(async () => (await readRowDraft(page, key))?.note ?? "").toContain(first.trim());
  await saveNote(page, id);
  await textarea.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(second, { delay: 30 });

  const saved = await waitForServerNote(
    context.request, auth.token, "ZEC", 8, id, (n) => (n ?? "").includes(first.trim()),
  );
  expect(saved.note ?? "", "the in-flight Save carried only the first typing").not.toContain(second.trim());
  await expect.poll(() => outboxCount(page)).toBe(0);

  await expectStays(async () => {
    const d = await readRowDraft(page, key);
    return !!d && (d.note ?? "").includes(second.trim());
  }, "typing made during the Save must stay in the draft store after its 200");
  await expect(page.getByText(/^1 unsaved$/).first()).toBeVisible();
  await context.close();
});

test("a Save drained by a fresh tab still clears the saved draft", async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, auth } = await newUserContext(browser, "fresh1092");
  const tabA = await context.newPage();
  const chap = await fetchChapter(context.request, auth.token, "ZEC", 8);
  const row = chap.tn.find((r) => r.verse === 6 && r.ref_raw === "8:6");
  expect(row, "ZEC 8:6 needs a tn row").toBeTruthy();
  const id = row!.id;
  const key = `row:tn:ZEC:${id}`;

  // Tab A's PATCH never reaches the server, so the Save stays queued.
  await tabA.route((url) => url.pathname === `/api/rows/tn/${id}`, (route) =>
    route.request().method() === "PATCH" ? route.abort() : route.continue());
  await gotoVerse(tabA, "ZEC", 8, 6);
  const textarea = await openNoteEditor(tabA, id);
  const typed = " FRESH1092";
  await textarea.click();
  await tabA.keyboard.press("ControlOrMeta+End");
  await tabA.keyboard.type(typed, { delay: 30 });
  await expect.poll(async () => (await readRowDraft(tabA, key))?.note ?? "").toContain(typed.trim());
  await saveNote(tabA, id);
  // Close tab A only once its failed attempt is recorded: closing it while
  // the PATCH is in flight leaves an in_flight op that another tab will not
  // re-arm until it is stale.
  await expect
    .poll(async () => (await outboxOps(tabA)).some((o) => o.startsWith("pending:") && !o.endsWith(":0")))
    .toBe(true);
  await tabA.close();

  // Tab B never wrote this draft and does not show the note (another
  // chapter); it drains the queued Save.
  const tabB = await context.newPage();
  await tabB.goto("/#/ZEC/1");
  await waitForServerNote(context.request, auth.token, "ZEC", 8, id, (n) => (n ?? "").includes(typed.trim()), 20_000);
  await expect.poll(() => outboxCount(tabB)).toBe(0);
  await expect
    .poll(() => readRowDraft(tabB, key), { message: "the saved draft must be cleared", timeout: 10_000 })
    .toBeNull();
  await context.close();
});

test("a Save drained by a tab holding an older draft generation of its own still clears the draft (#1100)", async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, auth } = await newUserContext(browser, "older1100");
  const chap = await fetchChapter(context.request, auth.token, "ZEC", 8);
  const row = chap.tn.find((r) => r.verse === 7 && r.ref_raw === "8:7");
  expect(row, "ZEC 8:7 needs a tn row").toBeTruthy();
  const id = row!.id;
  const key = `row:tn:ZEC:${id}`;

  // Tab B types in the note without saving, then leaves the chapter. Its
  // in-memory latest generation for this note stays the older one.
  const tabB = await context.newPage();  await gotoVerse(tabB, "ZEC", 8, 7);
  const textareaB = await openNoteEditor(tabB, id);
  const older = " OLDB1100";
  await textareaB.click();
  await tabB.keyboard.press("ControlOrMeta+End");
  await tabB.keyboard.type(older, { delay: 30 });
  await expect.poll(async () => (await readRowDraft(tabB, key))?.note ?? "").toContain(older.trim());
  await tabB.evaluate(() => { location.hash = "#/ZEC/1"; });
  await expect.poll(async () => (await readRowDraft(tabB, key))?.note ?? "").toContain(older.trim());

  // Tab A writes a newer draft of the same note and saves it, but its PATCH
  // never reaches the server, so the Save stays queued for tab B to drain.
  const tabA = await context.newPage();
  await tabA.route((url) => url.pathname === `/api/rows/tn/${id}`, (route) =>
    route.request().method() === "PATCH" ? route.abort() : route.continue());
  await gotoVerse(tabA, "ZEC", 8, 7);
  const textareaA = await openNoteEditor(tabA, id);
  const newer = " NEWA1100";
  await textareaA.click();
  await tabA.keyboard.press("ControlOrMeta+End");
  await tabA.keyboard.type(newer, { delay: 30 });
  await expect.poll(async () => (await readRowDraft(tabA, key))?.note ?? "").toContain(newer.trim());
  await saveNote(tabA, id);
  await expect
    .poll(async () => (await outboxOps(tabA)).some((o) => o.startsWith("pending:") && !o.endsWith(":0")))
    .toBe(true);
  await tabA.close();

  // Wake tab B's drain; it lands tab A's Save.
  await tabB.evaluate(() => window.dispatchEvent(new Event("online")));
  await waitForServerNote(context.request, auth.token, "ZEC", 8, id, (n) => (n ?? "").includes(newer.trim()), 20_000);
  await expect.poll(() => outboxCount(tabB)).toBe(0);
  await expect
    .poll(() => readRowDraft(tabB, key), { message: "the saved draft must be cleared", timeout: 10_000 })
    .toBeNull();
  await context.close();
});
