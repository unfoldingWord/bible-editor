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
// it is unsaved.

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

  // Move the note to v5 through the reference chip's menu.
  await page.locator(`[data-note-id="${id}"] .MuiChip-root`).filter({ hasText: "8:3" }).click();
  await page.getByRole("menuitem", { name: "v5", exact: true }).click();
  const moved = await waitForServerNote(context.request, auth.token, "ZEC", 8, id, () => true);
  await expect
    .poll(async () => (await fetchChapter(context.request, auth.token, "ZEC", 8)).tn.find((r) => r.id === id)?.verse)
    .toBe(5);
  expect(moved).toBeTruthy();
  // Let the move's 200 and any draft clear settle.
  await page.waitForTimeout(1_500);

  const server = (await fetchChapter(context.request, auth.token, "ZEC", 8)).tn.find((r) => r.id === id)!;
  expect(server.note ?? "", "the move must not carry the typing").not.toContain(typed.trim());
  const draft = await readRowDraft(page, key);
  expect(draft?.note ?? "", "the typed text must still be in the draft store").toContain(typed.trim());
  expect(draft?.expectedVersion, "the draft must be based on the moved row's version").toBe(server.version);
  expect(draft?.verse, "the draft must point at the new verse").toBe(5);
  await expect(page.getByText(/^1 unsaved$/).first()).toBeVisible();

  // Save stores the typing and clears the draft.
  await saveNote(page, id);
  await waitForServerNote(context.request, auth.token, "ZEC", 8, id, (n) => (n ?? "").includes(typed.trim()));
  await expect.poll(() => readRowDraft(page, key)).toBeNull();
  await context.close();
});
