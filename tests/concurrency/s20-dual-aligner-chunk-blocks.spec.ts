import { expect, test } from "@playwright/test";
import { newUserContext } from "./helpers";

// S20 — issue #903 / PR #939 review A1: SideBySideAligner is a lazy chunk.
// Before it was lazy, its full-screen Dialog mounted the moment "Side-by-side"
// was clicked and blocked the single AlignmentPanel behind it. With a
// `Suspense fallback={null}`, a cold chunk cache left the single panel visible
// and usable while the chunk downloaded; drags made there, then a same-verse
// save in the dual aligner, hit AlignmentPanel's sync-effect full reset and
// were dropped. openDualAligner checks the single panel for unsaved drags only
// at click time, so nothing caught them.
//
// What this guards: while the dual-aligner chunk is still loading, a modal
// loading state covers the single panel (a click aimed at it lands on the
// overlay), and the dual aligner still opens once the chunk arrives.

const BOOK = "ZEC";
const CHAPTER = 7;
const VERSE = 2;
const BV = "ULT";
const CHUNK_DELAY_MS = 4_000;

test("single aligner panel is blocked while the dual-aligner chunk loads", async ({ browser }) => {
  test.setTimeout(60_000);
  const { context } = await newUserContext(browser, "s20-user");
  const page = await context.newPage();
  try {
    // Hold the SideBySideAligner module (vite dev serves it as its own
    // request; a production build serves it as a hashed chunk) so the
    // loading window is wide enough to observe.
    let held = 0;
    await page.route(/SideBySideAligner[^/]*\.(tsx|js)(\?.*)?$/, async (route) => {
      held++;
      await new Promise((r) => setTimeout(r, CHUNK_DELAY_MS));
      await route.continue();
    });

    await page.goto(`/#/${BOOK}/${CHAPTER}/${VERSE}`);
    await page.reload();
    await page
      .locator(`[data-find-cell="${CHAPTER}-${VERSE}-${BV}"]`)
      .first()
      .waitFor({ timeout: 15_000 });
    await page.locator(`button[aria-label^="align ${BV}"]`).first().click();
    const sideBySide = page.locator("button", { hasText: "Side-by-side" }).first();
    await sideBySide.waitFor({ state: "visible" });
    const box = await sideBySide.boundingBox();
    expect(box).not.toBeNull();
    await sideBySide.click();

    // The chunk request is in flight and the dual dialog is not up yet.
    await expect.poll(() => held).toBeGreaterThan(0);
    const dialog = page.getByRole("dialog").filter({ hasText: "reading text" });
    await expect(dialog).toHaveCount(0);

    // The single panel underneath is not reachable (the topmost element at
    // the panel's own button is not part of the panel), and a loading
    // indicator shows.
    const hitsPanel = await page.evaluate(
      ({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        return !!el?.closest("button")?.textContent?.includes("Side-by-side");
      },
      { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 },
    );
    expect(hitsPanel, "single aligner panel is still clickable while the dual chunk loads").toBe(false);
    await expect(page.getByRole("progressbar").first()).toBeVisible();

    // Once the chunk arrives the dual aligner replaces the loading state.
    await expect(dialog).toBeVisible({ timeout: CHUNK_DELAY_MS + 10_000 });
  } finally {
    await context.close();
  }
});
