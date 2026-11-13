import { expect, test } from "@playwright/test";
import { newUserContext, gotoVerse } from "./helpers";

// S30 — A "see how you translated this" link must move to its verse every
// time it is clicked: the look-back magnifier beside the SH chip, and the
// link in the note body's read view.
//
// Root cause: both used to assign `location.hash`. Picking a verse inside the
// app (a click, the Back button) moves the active verse without rewriting the
// hash, so the hash keeps whatever verse the last link or chapter change put
// there. When the link pointed at that same verse, assigning it fired no
// hashchange (or, for verse 1, `#/ZEC/5` -> `#/ZEC/5/1` parsed to the verse
// Shell already had), and the click did nothing.
//
// Read-only: uses seeded ZEC notes ccxv (4:8, links 4:6) and gd7p (5:9,
// links 5:1), and changes nothing on the server.

const activeLabel = (page: import("@playwright/test").Page) => page.getByText(/^ZEC \d+:\d+$/).first();
const lookBack = (page: import("@playwright/test").Page, rowId: string) =>
  page.locator(`[data-note-id="${rowId}"] [aria-label^="Look back at"]`).first().click();

test("look-back reaches its verse after Back, again and again", async ({ browser }) => {
  const { context } = await newUserContext(browser, "carol");
  const page = await context.newPage();
  await gotoVerse(page, "ZEC", 4, 8);
  await page.locator('[data-note-id="ccxv"]').waitFor();
  for (let i = 0; i < 3; i++) {
    await lookBack(page, "ccxv");
    await expect(activeLabel(page)).toHaveText("ZEC 4:6");
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(activeLabel(page)).toHaveText("ZEC 4:8");
  }
  await context.close();
});

test("look-back to verse 1 works after landing on the chapter", async ({ browser }) => {
  const { context } = await newUserContext(browser, "carol");
  const page = await context.newPage();
  await gotoVerse(page, "ZEC", 5, 1);
  await page.getByText("5:9", { exact: true }).first().click();
  await expect(activeLabel(page)).toHaveText("ZEC 5:9");
  await lookBack(page, "gd7p");
  await expect(activeLabel(page)).toHaveText("ZEC 5:1");
  await context.close();
});

test("look-back and the body link reach the verse the URL already names", async ({ browser }) => {
  const { context } = await newUserContext(browser, "carol");
  const page = await context.newPage();
  await gotoVerse(page, "ZEC", 4, 6);
  await page.getByText("4:8", { exact: true }).first().click();
  await expect(activeLabel(page)).toHaveText("ZEC 4:8");
  await lookBack(page, "ccxv");
  await expect(activeLabel(page)).toHaveText("ZEC 4:6");

  await page.getByText("4:8", { exact: true }).first().click();
  await expect(activeLabel(page)).toHaveText("ZEC 4:8");
  await page.locator('[data-note-id="ccxv"]').getByText("4:6", { exact: true }).first().click();
  await expect(activeLabel(page)).toHaveText("ZEC 4:6");
  await context.close();
});
