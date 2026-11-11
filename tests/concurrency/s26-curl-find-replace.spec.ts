import { expect, test, type Page } from "@playwright/test";
import { gotoVerse, newUserContext } from "./helpers";

// S26 — issue #1276: find/replace saves curly quotes, like a verse text edit
// (#1273). A replacement containing ' is stored as ’ and repainted, untouched
// aligned words stay aligned, and a ’ → ' replace (which the curl undoes) sends
// no PATCH and does not bump the verse version.

interface VerseRow {
  plain_text: string;
  version: number;
  content: { verseObjects?: unknown[] };
}

// "word:strong" for every aligned \w, in document order.
function alignedWords(content: { verseObjects?: unknown[] }): string[] {
  const out: string[] = [];
  const walk = (nodes: unknown[] | undefined, strong: string | null) => {
    for (const node of nodes ?? []) {
      const o = node as Record<string, unknown> | null;
      if (!o) continue;
      const next = o.tag === "zaln" ? String(o.strong) : strong;
      if (o.type === "word" && next) out.push(`${o.text}:${next}`);
      if (Array.isArray(o.children)) walk(o.children as unknown[], next);
    }
  };
  walk(content.verseObjects, null);
  return out;
}

// Search for `find` (a single hit, in `cell`), make it the active match, and
// replace it once.
async function replaceOnce(page: Page, find: string, replacement: string, cell: string): Promise<void> {
  const findInput = page.getByPlaceholder("find");
  await findInput.fill(find);
  await findInput.press("Enter");
  await expect(page.locator(`[data-find-cell="${cell}"] mark.be-find-active`).first()).toBeVisible();
  await expect(page.getByText(/^1 \/ 1$/)).toBeVisible();
  await page.getByPlaceholder("replace").fill(replacement);
  await page.getByRole("button", { name: "replace", exact: true }).click();
}

test("find/replace saves curly quotes and a ’ → ' replace is a no-op", async ({ browser }) => {
  test.setTimeout(60_000);
  const { context } = await newUserContext(browser, "curl1276");
  const page = await context.newPage();
  const fetchVerse = async (verse: number): Promise<VerseRow> => {
    const res = await context.request.get("/api/chapters/ZEC/1");
    expect(res.ok()).toBe(true);
    return (await res.json()).verses.ULT[String(verse)] as VerseRow;
  };
  const patches: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "PATCH" && req.url().includes("/api/verses/")) patches.push(req.url());
  });

  // 1. A replacement with a straight ' in ZEC 1:2 ULT.
  const before2 = await fetchVerse(2);
  await gotoVerse(page, "ZEC", 1, 2);
  await page.getByRole("button", { name: "find" }).click();
  await replaceOnce(page, "with your fathers", "with Judah's fathers", "1-2-ULT");

  await expect.poll(async () => (await fetchVerse(2)).version).toBeGreaterThan(before2.version);
  const after2 = await fetchVerse(2);
  console.log(`[s26] 1:2 before: ${JSON.stringify(before2.plain_text)} v${before2.version}`);
  console.log(`[s26] 1:2 after:  ${JSON.stringify(after2.plain_text)} v${after2.version}`);
  console.log(`[s26] 1:2 aligned before ${alignedWords(before2.content).length}, after ${alignedWords(after2.content).length}`);
  expect.soft(after2.plain_text).toContain("angry with Judah’s fathers");
  expect.soft(after2.plain_text).not.toMatch(/['"]/);
  // Every aligned word except the replaced "your" keeps its alignment.
  expect.soft(alignedWords(after2.content)).toEqual(alignedWords(before2.content).filter((x) => !x.startsWith("your:")));
  await expect.soft(page.locator('[data-find-cell="1-2-ULT"]').first()).toContainText("Judah’s");

  // 2. ’ → ' in ZEC 1:6 ULT: the curl undoes it, so nothing is saved. Before
  // #1276 this replace rewrote the aligned word "us", the save guard refused
  // it with an alignment-loss toast, and the overlay still said "replaced 1".
  const before6 = await fetchVerse(6);
  const patchesBefore = patches.length;
  await replaceOnce(page, "us.’", "us.'", "1-6-ULT");
  await page.waitForTimeout(2500);
  const after6 = await fetchVerse(6);
  console.log(`[s26] 1:6 PATCHes sent: ${patches.length - patchesBefore}; version v${before6.version} -> v${after6.version}`);
  console.log(`[s26] 1:6 after: ${JSON.stringify(after6.plain_text.slice(-20))}`);
  expect.soft(patches.length - patchesBefore).toBe(0);
  expect.soft(after6.version).toBe(before6.version);
  expect.soft(after6.plain_text).toBe(before6.plain_text);
  await expect.soft(page.getByText(/can't preserve word alignment/)).toHaveCount(0);
  await expect.soft(page.getByText(/^replaced 1 verse/)).toHaveCount(0);

  await context.close();
});
