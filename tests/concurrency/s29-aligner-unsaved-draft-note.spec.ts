import { expect, test, type Page } from "@playwright/test";
import { newUserContext } from "./helpers";

// S29 — issue #1254: text typed in the rows editor sits in the drafts store
// until Save, and the aligner shows the saved wording. The aligner must say
// so (a warning, not a block). Each test uses its own verse and a fresh
// context, so no draft or outbox op leaks between them.

const DRAFT_NOTE = "This verse has typed text that isn't saved; this screen shows the saved wording.";
const OUTBOX_NOTE = "This verse has an edit that hasn't saved yet.";
const BOTH_NOTE =
  "This verse has an edit that hasn't saved yet, plus typed text that isn't saved; " +
  "this screen shows the edit but not the typed text.";

const cellFor = (page: Page, verse: number, bv: "ULT" | "UST") =>
  page.locator(`[contenteditable="true"][data-find-cell="1-${verse}-${bv}"]`);

async function typeAtEnd(page: Page, verse: number, bv: "ULT" | "UST", text: string) {
  const cell = cellFor(page, verse, bv);
  await cell.waitFor();
  await cell.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText(text);
  await expect(cell).toHaveAttribute("data-dirty", "true");
  return cell;
}

const note = (page: Page) => page.getByTestId("aligner-unsaved-note");

test("typed, unsaved text shows the note; it clears when the draft goes away", async ({ browser }) => {
  test.setTimeout(60_000);
  const { context } = await newUserContext(browser, "s29a");
  const page = await context.newPage();
  await page.goto("/#/ZEC/1/3");
  await typeAtEnd(page, 3, "ULT", " Zqdraftword");

  await page.locator('button[aria-label^="align ULT"]').first().click();
  await expect(note(page)).toHaveText(DRAFT_NOTE);
  await page.screenshot({ path: "test-results/s29-draft-note.png" });

  // Discarding the draft while the panel is open clears the note (live
  // subscription, not a check on open).
  await page.evaluate(async () => {
    const mod = await import("/src/sync/drafts.ts");
    await mod.drafts.clear("verse:ZEC:1:3:ULT");
  });
  await expect(note(page)).toHaveCount(0);
  await context.close();
});

test("a verse without typed text shows no note", async ({ browser }) => {
  const { context } = await newUserContext(browser, "s29b");
  const page = await context.newPage();
  await page.goto("/#/ZEC/1/4");
  await cellFor(page, 4, "ULT").waitFor();
  await page.locator('button[aria-label^="align ULT"]').first().click();
  // The panel is up (its footer's Side-by-side action renders) and no note shows.
  await expect(page.locator("button", { hasText: "Side-by-side" }).first()).toBeVisible();
  await expect(note(page)).toHaveCount(0);
  await page.screenshot({ path: "test-results/s29-no-note.png" });
  await context.close();
});

test("a stuck save shows one note; typing after it switches to the combined note", async ({ browser }) => {
  test.setTimeout(60_000);
  const { context } = await newUserContext(browser, "s29c");
  const page = await context.newPage();
  // Every verse PATCH fails at the network, so the op stays in the outbox.
  await page.route("**/api/verses/**", (route) =>
    route.request().method() === "PATCH" ? route.abort() : route.continue());
  await page.goto("/#/ZEC/1/6");
  const cell = await typeAtEnd(page, 6, "ULT", " Zqsavedword");
  await cell.locator("xpath=..").locator('[aria-label="save edits"] button').click();

  await page.locator('button[aria-label^="align ULT"]').first().click();
  // The save captured the draft, so only the outbox note shows.
  await expect(note(page)).toHaveText(OUTBOX_NOTE);

  // Newer typing after the queued save: the one note becomes the combined one.
  await typeAtEnd(page, 6, "ULT", " Zqnewerword");
  await expect(note(page)).toHaveText(BOTH_NOTE, { timeout: 10_000 });
  await page.screenshot({ path: "test-results/s29-both-note.png" });
  await context.close();
});

test("side-by-side aligner: only the panel whose verse has typed text shows the note", async ({ browser }) => {
  test.setTimeout(60_000);
  const { context } = await newUserContext(browser, "s29d");
  const page = await context.newPage();
  await page.goto("/#/ZEC/1/5");
  await typeAtEnd(page, 5, "ULT", " Zqdraftword");

  await page.locator('button[aria-label^="align ULT"]').first().click();
  const sideBySide = page.locator("button", { hasText: "Side-by-side" }).first();
  await sideBySide.waitFor({ state: "visible" });
  await sideBySide.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByTestId("aligner-unsaved-note")).toHaveCount(1);
  await expect(dialog.getByTestId("aligner-unsaved-note")).toHaveText(DRAFT_NOTE);
  await page.screenshot({ path: "test-results/s29-side-by-side.png" });
  await context.close();
});
