import { expect, test } from "@playwright/test";
import { newUserContext } from "./helpers";

// S15 — issue #806: the same verse open in two tabs of ONE browser (shared
// IndexedDB draft store + BroadcastChannel). Typing in tab A must not push a
// half-typed snapshot into the untouched tab B, nor mark B's cell dirty.
// Benjamin's decision (option A): B stays put while the verse is on screen and
// shows A's draft only when the verse next mounts (reload / reopen).
// Each scripture mode has its own verse cell with its own draft subscription
// (ScriptureColumn ActiveLine, DocColumn, BookView VerseCell).
for (const mode of ["rows", "columns", "book"] as const) {
test(`${mode}: typing in one tab does not change or dirty the same verse in another tab`, async ({ browser }) => {
  test.setTimeout(90_000);
  const { context } = await newUserContext(browser, `tabs806-${mode}`);
  const tabA = await context.newPage();
  const tabB = await context.newPage();
  const cellSel = mode === "rows"
    ? '[contenteditable="true"][data-find-cell="6-2-ULT"]'
    : '[data-find-cell="6-2-ULT"] [contenteditable="true"]';
  // Tab A picks the mode; the choice persists in the shared localStorage, so
  // tab B and its later reload open in the same mode without a click.
  const open = async (page: typeof tabA, pickMode: boolean) => {
    await page.goto("/#/ZEC/6/2");
    if (pickMode && mode !== "rows") {
      await page.locator("button").filter({ hasText: new RegExp(`^${mode}$`) }).click();
    }
    await page.locator(cellSel).waitFor();
  };
  await open(tabA, true);
  await open(tabB, false);
  const cellA = tabA.locator(cellSel);
  const cellB = tabB.locator(cellSel);
  await cellA.waitFor();
  await cellB.waitFor();
  const original = (await cellB.textContent()) ?? "";
  expect(original.length).toBeGreaterThan(0);

  const typed = " TABA806";
  await cellA.click();
  await tabA.keyboard.press("ControlOrMeta+End");
  await tabA.keyboard.type(typed, { delay: 80 });
  await expect(cellA).toHaveText(original + typed);

  // Wait until A's full text is persisted in the shared draft store, then
  // give B's BroadcastChannel notifications time to land.
  await expect.poll(() => tabB.evaluate(async (needle) => {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const req = indexedDB.open("bible-editor-drafts", 1);
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    const rec = await new Promise<{ payload?: { plainText?: string } } | undefined>((res, rej) => {
      const req = db.transaction("drafts").objectStore("drafts").get("verse:ZEC:6:2:ULT");
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    db.close();
    return rec?.payload?.plainText?.endsWith(needle) ?? false;
  }, typed.trim())).toBe(true);
  await tabB.waitForTimeout(1_000);

  expect(await cellB.textContent(), "tab B's text must not change").toBe(original);
  expect(await cellB.getAttribute("data-dirty"), "tab B's cell must not be marked dirty").toBeNull();

  // Reopening the verse in B (reload) hydrates from the saved draft.
  // The unsaved-work guard prompts on unload (the shared draft store holds
  // tab A's typing); accept it so the reload goes through.
  tabB.once("dialog", (d) => void d.accept());
  await tabB.reload();
  await tabB.locator(cellSel).waitFor();
  await expect(tabB.locator(cellSel)).toHaveText(original + typed);
  await expect(tabB.locator(cellSel)).toHaveAttribute("data-dirty", "true");

  // Drafts live in this context's IndexedDB only; nothing was saved to D1.
  await context.close();
});
}
