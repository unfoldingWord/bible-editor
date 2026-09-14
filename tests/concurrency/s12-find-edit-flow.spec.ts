import { expect, test } from "@playwright/test";
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
// The typed query is now debounced and only peeks (scrolls) at the nearest
// hit; explicit Enter/next activates the match verse once; a manual click
// elsewhere sticks; fast typing keeps every character.
test("Find does not steal the active verse or drop keystrokes", async ({ browser }) => {
  const { context } = await newUserContext(browser, "find-editor");
  const page = await context.newPage();
  const activeCaption = page.getByText(/^ZEC \d+:\d+$/).first();

  // Start on ZEC 1:3 in the default rows mode.
  await gotoVerse(page, "ZEC", 1, 3);
  await expect(activeCaption).toHaveText("ZEC 1:3");

  // Typing a query must not move the active verse (there are hits in 1:1).
  await page.getByRole("button", { name: "find" }).click();
  const findInput = page.getByPlaceholder("find");
  await expect(findInput).toBeVisible();
  await findInput.type("Yahweh", { delay: 30 });
  await expect(page.getByText(/^\d+ \/ \d+$/)).toBeVisible();
  await expect(activeCaption).toHaveText("ZEC 1:3");

  // Enter activates the current match verse — the nearest hit at/after 1:3 is
  // in 1:3 itself, so the caption stays; step once more to leave 1:3.
  const nextMatch = page.getByRole("button", { name: "next match" });
  await nextMatch.click();
  await expect(activeCaption).toHaveText(/^ZEC 1:\d+$/);

  // Click a different verse to edit it: it must become — and stay — active.
  await page.locator("text=/^1:6$/").first().click();
  await expect(activeCaption).toHaveText("ZEC 1:6");
  await page.waitForTimeout(800);
  await expect(activeCaption).toHaveText("ZEC 1:6");

  // Fast typing into the (only) editable cell keeps every character.
  const cell = page.locator('[contenteditable="true"][data-find-cell="1-6-ULT"]');
  await expect(cell).toBeVisible();
  await cell.click({ position: { x: 20, y: 10 } });
  await page.keyboard.type("QQ");
  await page.waitForTimeout(600);
  await expect(cell).toContainText("QQ");
  await expect(activeCaption).toHaveText("ZEC 1:6");

  await context.close();
});
