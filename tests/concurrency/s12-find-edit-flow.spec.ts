import { expect, test, type Locator, type Page } from "@playwright/test";
import { gotoVerse, newUserContext } from "./helpers";

// S12 — Searching must not fight the user for the editing focus.
//
// Regression for the "everything jumps, it takes me somewhere else, and I have
// to click several times before it lets me edit" report. Three mechanisms sat
// behind it, all in the default rows (stacked) mode:
//
//  1. Every keystroke in the Find box navigated to match #1 and — because only
//     the active verse is editable in rows mode — re-activated that verse,
//     pulling the user off whatever they were reading.
//  2. The scroll-to-match effect keyed on `activeVerse`, so clicking a
//     different verse to edit it re-fired the effect and snapped the active
//     verse straight back to the match.
//  3. The verse cell's "hydrate from a saved draft" branch also ran on the
//     first draft the user's own keystrokes created; a stale store snapshot
//     was pushed back into the cell, dropping the newest characters and
//     collapsing the caret to the start.
//
// Now: the typed query is debounced and never scrolls; the nearest hit at/after
// the user's verse is the candidate for the first Enter, which activates that
// hit; Enter inside the debounce window searches AND goes there; a manual
// click elsewhere sticks; fast typing keeps every character; a TN-only search
// never changes the verse while typing.

// `${chapter}-${verse}-${version}` of the cell holding the orange active mark.
async function activeMarkCell(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const m = document.querySelector("mark.be-find-active");
    return m?.closest("[data-find-cell]")?.getAttribute("data-find-cell") ?? null;
  });
}

async function scrollOffsets(cell: Locator): Promise<number[]> {
  return cell.evaluate((el) => {
    const offsets: number[] = [];
    for (let parent = el.parentElement; parent; parent = parent.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) offsets.push(parent.scrollTop);
    }
    return offsets;
  });
}

test("Find does not steal the active verse or drop keystrokes", async ({ browser }) => {
  const { context } = await newUserContext(browser, "find-editor");
  const page = await context.newPage();
  const activeCaption = page.getByText(/^ZEC \d+:\d+$/).first();

  // Start on ZEC 1:3 in the default rows mode.
  await gotoVerse(page, "ZEC", 1, 3);
  await expect(activeCaption).toHaveText("ZEC 1:3");

  // Typing a query must not move the active verse. "angry" has hits in 1:2
  // (before us) and 1:12 / 1:15 (after us): typing must leave the viewport
  // in place even after the debounce fires.
  await page.getByRole("button", { name: "find" }).click();
  const findInput = page.getByPlaceholder("find");
  await expect(findInput).toBeVisible();
  await page.waitForTimeout(400);
  const currentCell = page.locator('[data-find-cell="1-3-ULT"]').first();
  const beforeSearch = await scrollOffsets(currentCell);
  await findInput.type("angry", { delay: 30 });
  await expect(page.getByText(/^\d+ \/ 8$/)).toBeVisible();
  await expect(activeCaption).toHaveText("ZEC 1:3");
  expect(await activeMarkCell(page)).toBeNull();
  expect(await scrollOffsets(currentCell)).toEqual(beforeSearch);

  // The first Enter commits to the highlighted hit — not the one after it.
  await findInput.press("Enter");
  await expect(activeCaption).toHaveText("ZEC 1:12");
  expect(await activeMarkCell(page)).toBe("1-12-UST");

  // Click a different verse's row to edit it: it must become — and stay —
  // active (the row's ULT cell carries the same data-find-cell anchor).
  await page.locator('[data-find-cell="1-6-ULT"]').click();
  await expect(activeCaption).toHaveText("ZEC 1:6");
  await page.waitForTimeout(500);
  await expect(activeCaption).toHaveText("ZEC 1:6");

  // Fast typing into the (only) editable cell keeps every character.
  const cell = page.locator('[contenteditable="true"][data-find-cell="1-6-ULT"]');
  await expect(cell).toBeVisible();
  await cell.click({ position: { x: 20, y: 10 } });
  await page.keyboard.type("QQ");
  await page.waitForTimeout(400);
  await expect(cell).toContainText("QQ");
  await expect(activeCaption).toHaveText("ZEC 1:6");

  // Leaving Find before its debounce settles must not schedule a later jump
  // while the user is back in the verse editor.
  await findInput.fill("house");
  await cell.click({ position: { x: 20, y: 10 } });
  const editingOffsets = await scrollOffsets(cell);
  await page.waitForTimeout(400);
  await expect(activeCaption).toHaveText("ZEC 1:6");
  expect(await scrollOffsets(cell)).toEqual(editingOffsets);

  // Enter inside the debounce window searches AND activates the hit. "myrtle"
  // sits in 1:8 / 1:10 / 1:11, so the nearest hit at/after 1:6 is 1:8. (Not a
  // word in 1:6 itself: the dirty cell deliberately keeps its draft render and
  // does not repaint marks — #642.)
  await findInput.click();
  await findInput.fill("");
  await findInput.type("myrtle");
  await findInput.press("Enter");
  await expect(activeCaption).toHaveText("ZEC 1:8");
  expect(await activeMarkCell(page)).toMatch(/^1-8-/);
  const verseBeforeTn = await activeCaption.innerText();

  // TN-only scope: typing must not activate the note's verse either ("Darius"
  // appears only in a 1:1 note in this chapter). Enter then goes there.
  await page.getByLabel("TN").check();
  await page.getByLabel("Bible").uncheck();
  await findInput.fill("");
  await findInput.type("Darius", { delay: 30 });
  await expect(page.getByText(/^1 \/ 1$/)).toBeVisible();
  await page.waitForTimeout(400);
  await expect(activeCaption).toHaveText(verseBeforeTn);
  await findInput.press("Enter");
  await expect(activeCaption).toHaveText("ZEC 1:1");

  await context.close();
});

for (const mode of ["rows", "columns", "book"] as const) {
  test(`${mode}: selecting visible verse does not recenter the editing pane`, async ({ browser }) => {
    const { context } = await newUserContext(browser, `stable-${mode}`);
    const page = await context.newPage();
    await gotoVerse(page, "ZEC", 1, 3);
    if (mode !== "rows") await page.locator("button").filter({ hasText: new RegExp(`^${mode}$`) }).click();
    const target = page.locator('[data-find-cell="1-6-ULT"]').first();
    await target.scrollIntoViewIfNeeded();
    await page.waitForTimeout(700);
    // Record application scroll requests after Playwright has made the target
    // visible. Native scroll anchoring may compensate for rows mode's expanded
    // editor, but activation must not start a smooth centering animation.
    await page.evaluate(() => {
      const original = Element.prototype.scrollIntoView;
      (window as unknown as { scriptureScrolls: number }).scriptureScrolls = 0;
      Element.prototype.scrollIntoView = function (...args) {
        if (this.closest('[data-find-cell="1-6-ULT"]') ||
            this.querySelector('[data-find-cell="1-6-ULT"]')) {
          (window as unknown as { scriptureScrolls: number }).scriptureScrolls++;
        }
        return original.apply(this, args);
      };
    });
    await target.click();
    await expect(page.getByText(/^ZEC 1:6$/).first()).toBeVisible();
    await page.waitForTimeout(500);
    expect(await page.evaluate(() => (window as unknown as { scriptureScrolls: number }).scriptureScrolls)).toBe(0);

    // Explicit go-to-active retains its navigation semantics in every mode.
    await page.locator("button").filter({ hasText: /^go to active$/ }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { scriptureScrolls: number }).scriptureScrolls)).toBeGreaterThan(0);
    if (mode === "book") {
      // Selecting a verse in another loaded chapter briefly remounts BookView
      // while useChapter loads its resources. Preserve the clicked viewport.
      const nextChapter = page.locator('[data-find-cell="2-2-ULT"]').first();
      await nextChapter.scrollIntoViewIfNeeded();
      await page.waitForTimeout(700);
      const beforeChapterClick = await nextChapter.evaluate(el => el.getBoundingClientRect().top);
      await nextChapter.click();
      await expect(page.getByText(/^ZEC 2:2$/).first()).toBeVisible();
      await expect.poll(async () => Math.abs(await nextChapter.evaluate(el => el.getBoundingClientRect().top) - beforeChapterClick)).toBeLessThanOrEqual(1);
    }
    await context.close();
  });
}
