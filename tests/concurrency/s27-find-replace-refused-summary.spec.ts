import { expect, test, type Page } from "@playwright/test";
import { gotoVerse, newUserContext } from "./helpers";

// S27 — issue #1285: the Find/replace overlay's "replaced N verses" summary
// counts only verses that were actually queued for save. A replace the
// alignment guard refuses (find_replace intent: a toast, nothing saved) must
// not be reported as replaced.
//
// The refused replaces change only the punctuation after an aligned word
// ("eyes." -> "eyes!"): the engine rewrites the word unaligned, and since its
// surface text is unchanged the guard reads that as collateral loss. The
// toast is asserted first in each leg, so if the engine ever learns to keep
// these aligned the test fails at that precondition instead of passing
// vacuously; pick another refused replace then.

interface VerseRow {
  plain_text: string;
  version: number;
}

// Shell shows one toast at a time (8 s), naming the refused verse.
const refusedToast = (page: Page, ref: string) =>
  page.getByText(new RegExp(`can.t preserve word alignment.*\\(ZEC ${ref}`));

async function search(page: Page, find: string, cell: string): Promise<void> {
  const findInput = page.getByPlaceholder("find");
  await findInput.fill(find);
  await findInput.press("Enter");
  await expect(page.locator(`[data-find-cell="${cell}"] mark.be-find-active`).first()).toBeVisible();
}

test("find/replace summary counts only verses the alignment guard let through", async ({ browser }) => {
  test.setTimeout(90_000);
  const { context } = await newUserContext(browser, "refused1285");
  const page = await context.newPage();
  const fetchVerse = async (chapter: number, version: string, verse: number): Promise<VerseRow> => {
    const res = await context.request.get(`/api/chapters/ZEC/${chapter}`);
    expect(res.ok()).toBe(true);
    return (await res.json()).verses[version][String(verse)] as VerseRow;
  };
  const patches: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "PATCH" && req.url().includes("/api/verses/")) patches.push(req.url());
  });
  const summary = page.locator(".MuiAlert-message").filter({ hasText: /verses? not replaced|replaced \d+ verse/ });

  // 1. Single replace the guard refuses: ZEC 3:9 ULT "eyes." -> "eyes!".
  const before39 = await fetchVerse(3, "ULT", 9);
  await gotoVerse(page, "ZEC", 3, 9);
  await page.getByRole("button", { name: "find" }).click();
  await search(page, "eyes.", "3-9-ULT");
  await page.getByPlaceholder("replace").fill("eyes!");
  await page.getByRole("button", { name: "replace", exact: true }).click();
  await expect(refusedToast(page, "3:9 ULT")).toBeVisible();
  await page.waitForTimeout(1500);
  const after39 = await fetchVerse(3, "ULT", 9);
  console.log(`[s27] 3:9 refused: PATCHes ${patches.length}, v${before39.version} -> v${after39.version}`);
  console.log(`[s27] 3:9 summary: ${JSON.stringify(await summary.allTextContents())}`);
  expect.soft(patches.length).toBe(0);
  expect.soft(after39.version).toBe(before39.version);
  await expect.soft(page.getByText(/replaced \d+ verse/)).toHaveCount(0);
  await expect.soft(page.getByText("1 verse not replaced: it would lose word alignment")).toBeVisible();

  // 2. A normal single replace still says "replaced 1 verse": ZEC 3:8 ULT
  // "Branch." -> "Branch!" keeps alignment and passes the guard.
  const before38 = await fetchVerse(3, "ULT", 8);
  await search(page, "Branch.", "3-8-ULT");
  await page.getByPlaceholder("replace").fill("Branch!");
  await page.getByRole("button", { name: "replace", exact: true }).click();
  await expect.poll(async () => (await fetchVerse(3, "ULT", 8)).version).toBeGreaterThan(before38.version);
  console.log(`[s27] 3:8 summary: ${JSON.stringify(await summary.allTextContents())}`);
  await expect.soft(page.getByText(/^replaced 1 verse$/)).toBeVisible();
  expect.soft((await fetchVerse(3, "ULT", 8)).plain_text).toContain("Branch!");
  expect.soft(patches.length).toBe(1);

  // 3. Replace-all over two verses, one refused: "Babylon." -> "Babylon!"
  // matches ZEC 6:10 ULT (refused) and ZEC 6:10 UST (saved).
  const ult610 = await fetchVerse(6, "ULT", 10);
  const ust610 = await fetchVerse(6, "UST", 10);
  await gotoVerse(page, "ZEC", 6, 10);
  if ((await page.getByPlaceholder("find").count()) === 0) await page.getByRole("button", { name: "find" }).click();
  // Replace-all needs no active match; just wait until both verses are hits.
  // The chapter change can restore the previous query over a fill made while
  // chapter 6 is still loading, so retry the fill until the hit shows.
  await expect(async () => {
    await page.getByPlaceholder("find").fill("Babylon.");
    await expect(page.locator('[data-find-cell="6-10-ULT"] mark').first()).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15_000 });
  await expect(page.locator('[data-find-cell="6-10-UST"] mark').first()).toBeVisible();
  await page.getByPlaceholder("replace").fill("Babylon!");
  await page.getByRole("button", { name: "replace all" }).click();
  await page.getByRole("button", { name: "Replace 2 verses" }).click();
  await expect(refusedToast(page, "6:10 ULT")).toBeVisible();
  await expect.poll(async () => (await fetchVerse(6, "UST", 10)).version).toBeGreaterThan(ust610.version);
  await page.waitForTimeout(1500);
  console.log(`[s27] 6:10 replace-all summary: ${JSON.stringify(await summary.allTextContents())}; PATCHes total ${patches.length}`);
  expect.soft((await fetchVerse(6, "ULT", 10)).version).toBe(ult610.version);
  expect.soft(patches.length).toBe(2);
  // The saved UST verse still loses the replaced word's own milestone (not
  // collateral, so the guard allows it), hence the "destroyed in 1" part.
  await expect
    .soft(
      page.getByText(
        /^replaced 1 verse — alignment milestones destroyed in 1 — 1 verse not replaced: it would lose word alignment$/,
      ),
    )
    .toBeVisible();

  await context.close();
});
