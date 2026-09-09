import { expect, test } from "@playwright/test";
import { gotoVerse, newUserContext } from "./helpers";

// S10 — The Find bar (and the typed query) must survive a chapter change.
//
// Regression for the "Find keeps disappearing" report: clicking through
// matches that cross a chapter boundary — or any manual chapter move with Find
// open — used to blank the search after a couple of hits, forcing a retype.
//
// Root cause: useChapter nulls its payload on every (book, chapter) change
// (#531, to block editing stale content), which trips Shell's `!data` gate and
// unmounts ScriptureColumn and the Find overlay under it. Find state lived in
// that subtree, so it was destroyed. The fix reseeds the open flag + query from
// sessionStorage on remount (web/src/lib/findState.ts); this test locks that in
// through the real UI, and guards against over-persisting past a deliberate
// close.
test("Find bar and query survive a chapter change", async ({ browser }) => {
  const { context } = await newUserContext(browser, "finder");
  const page = await context.newPage();

  // Load ZEC 1 (gotoVerse waits for the chapter's notes to render).
  await gotoVerse(page, "ZEC", 1, 1);

  // Open Find and type a query.
  await page.getByRole("button", { name: "find" }).click();
  const findInput = page.getByPlaceholder("find");
  await expect(findInput).toBeVisible();
  await findInput.fill("the");
  await expect(findInput).toHaveValue("the");

  // Navigate to another chapter the way the app does — a hash change, not a
  // reload. This is exactly what "click next across a chapter boundary" does
  // under the hood, and what used to wipe the search.
  await page.evaluate(() => {
    window.location.hash = "#/ZEC/2";
  });
  // Confirm the chapter actually changed (ScriptureColumn remounted): the
  // toolbar caption reads the new chapter.
  await expect(page.getByText(/^ZEC 2:/).first()).toBeVisible({ timeout: 10_000 });

  // The fix: the bar is still open and the query is intact.
  await expect(findInput).toBeVisible();
  await expect(findInput).toHaveValue("the");

  // A deliberate close (Esc) must NOT be undone by the next chapter change —
  // don't over-persist. Close, navigate, and the bar stays gone.
  await findInput.press("Escape");
  await expect(findInput).toHaveCount(0);
  await page.evaluate(() => {
    window.location.hash = "#/ZEC/3";
  });
  await expect(page.getByText(/^ZEC 3:/).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByPlaceholder("find")).toHaveCount(0);

  await context.close();
});
