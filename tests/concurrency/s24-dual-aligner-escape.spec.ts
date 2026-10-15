import { expect, test, type Page } from "@playwright/test";
import { newUserContext } from "./helpers";

// S24 — Escape closes the side-by-side aligner. The Dialog's own Escape handler
// only fires while focus is inside it; once the focus trap was turned off
// (#1053), a click on a non-focusable spot left focus on <body> and Escape did
// nothing. A document-level listener in SideBySideAligner restores it.
//
// What this guards: with focus on <body> inside an open dual aligner, Escape
// closes it; and with the unsaved-changes gate stacked on top, Escape dismisses
// only the gate and the aligner (with its unsaved text) stays.

const BOOK = "ZEC";
const CHAPTER = 7;
const VERSE = 2;
const BV = "ULT";

async function openDual(page: Page) {
  await page.goto(`/#/${BOOK}/${CHAPTER}/${VERSE}`);
  await page.reload();
  await page
    .locator(`[data-find-cell="${CHAPTER}-${VERSE}-${BV}"]`)
    .first()
    .waitFor({ timeout: 15_000 });
  await page.locator(`button[aria-label^="align ${BV}"]`).first().click();
  await page.locator("button", { hasText: "Side-by-side" }).first().click();
  const dialog = page.getByRole("dialog").filter({ hasText: "reading text" });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  return dialog;
}

const blurToBody = async (page: Page) => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
};

test("Escape closes the side-by-side aligner even when focus is on the page body", async ({ browser }) => {
  test.setTimeout(60_000);
  const { context } = await newUserContext(browser, "s24-user");
  const page = await context.newPage();
  try {
    const dialog = await openDual(page);

    // Put focus on <body>: the state a click on a non-focusable spot leaves.
    await blurToBody(page);

    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test("Escape on the unsaved-changes gate dismisses only the gate", async ({ browser }) => {
  test.setTimeout(60_000);
  const { context } = await newUserContext(browser, "s24-gate-user");
  const page = await context.newPage();
  try {
    const dialog = await openDual(page);
    // Dirty a reading line, then ask to close: the gate opens over the aligner.
    const line = dialog.locator('[contenteditable="true"]:visible').first();
    await line.click();
    await page.keyboard.type("x");
    await page.keyboard.press("Escape");
    const gate = page.getByRole("dialog").filter({ hasText: "Unsaved changes" });
    await expect(gate).toBeVisible();

    // Escape dismisses the gate and leaves the aligner (and its text) up.
    await gate.getByRole("button", { name: "Cancel" }).focus();
    await page.keyboard.press("Escape");
    await expect(gate).toHaveCount(0);
    await expect(dialog).toBeVisible();
  } finally {
    await context.close();
  }
});
