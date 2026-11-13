import { expect, test } from "@playwright/test";
import { newUserContext, gotoVerse } from "./helpers";

// S32 — Back must return to a note that was focused just before a see-how
// look-back, even when the note itself was held for less than navHistory's
// SETTLE_MS (2.5 s), as long as the person had been on its verse that long.
//
// Root cause (#1376): focusing a note at the same verse made a new spot and
// restarted the settle clock, so following the note's look-back link within
// 2.5 s recorded nothing and Back was disabled.
//
// Read-only: uses seeded ZEC note ccxv (4:8, links 4:6) and changes nothing on
// the server.

const activeLabel = (page: import("@playwright/test").Page) => page.getByText(/^ZEC \d+:\d+$/).first();
// The focused note card's border is the theme's primary.main (measured; the
// 1.5px active border width renders as 1px at device scale 1, so it can't be used).
const ACTIVE_BORDER = "rgb(49, 173, 227)";

test("focus a note, look back within a second, Back returns to the note", async ({ browser }) => {
  const { context } = await newUserContext(browser, "carol");
  const page = await context.newPage();
  await gotoVerse(page, "ZEC", 4, 8);
  const card = page.locator('[data-note-id="ccxv"]').first();
  await card.waitFor();
  // Stay on the verse long enough for it to count as settled.
  await page.waitForTimeout(3_000);
  // Focus the note (top-left corner of the card, clear of the body editor).
  await card.click({ position: { x: 4, y: 4 } });
  await expect(card).toHaveCSS("border-top-color", ACTIVE_BORDER);
  await page.waitForTimeout(500);
  await card.locator('[aria-label^="Look back at"]').first().click();
  await expect(activeLabel(page)).toHaveText("ZEC 4:6");

  const back = page.getByRole("button", { name: "Back", exact: true });
  await expect(back).toBeEnabled();
  await back.click();
  await expect(activeLabel(page)).toHaveText("ZEC 4:8");
  await expect(card).toHaveCSS("border-top-color", ACTIVE_BORDER);
  await context.close();
});
