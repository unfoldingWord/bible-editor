import { expect, test } from "@playwright/test";
import { newUserContext } from "./helpers";

// S25 — issue #1273: the typing interceptor curls only a single typed quote, so
// a multi-character insert (predictive text, autocorrect, dictation) used to
// save straight quotes. The verse save now curls them, keeps every aligned
// word aligned, and the editor repaints with the curled text so the next
// edit does not diff ' against ’.

interface VerseRow {
  plain_text: string;
  content: { verseObjects?: unknown[] };
}

function alignedCount(content: { verseObjects?: unknown[] }): number {
  let n = 0;
  const walk = (nodes: unknown[] | undefined, inZaln: boolean) => {
    for (const node of nodes ?? []) {
      const o = node as Record<string, unknown> | null;
      if (!o) continue;
      if (o.type === "word" && inZaln) n++;
      if (Array.isArray(o.children)) walk(o.children as unknown[], inZaln || o.tag === "zaln");
    }
  };
  walk(content.verseObjects, false);
  return n;
}

test("a multi-character insert with straight quotes saves curled and keeps alignment", async ({ browser }) => {
  test.setTimeout(60_000);
  const { context } = await newUserContext(browser, "curl1273");
  const page = await context.newPage();
  const fetchVerse = async (): Promise<VerseRow> => {
    const res = await context.request.get("/api/chapters/ZEC/1");
    expect(res.ok()).toBe(true);
    return (await res.json()).verses.ULT["3"] as VerseRow;
  };
  const before = await fetchVerse();

  await page.goto("/#/ZEC/1/3");
  const cell = page.locator('[contenteditable="true"][data-find-cell="1-3-ULT"]');
  await cell.waitFor();
  await cell.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText(" \"the baby's toy\"");
  await expect(cell).toHaveAttribute("data-dirty", "true");
  await cell.locator("xpath=..").locator('[aria-label="save edits"] button').click();

  await expect.poll(async () => (await fetchVerse()).plain_text).toContain("“the baby’s toy”");
  const after = await fetchVerse();
  expect(after.plain_text).not.toMatch(/['"]/);
  expect(alignedCount(after.content)).toBe(alignedCount(before.content));

  // The editor repaints with the curled text once the save lands.
  await expect(cell).not.toHaveAttribute("data-dirty", "true");
  await expect(cell).toContainText("“the baby’s toy”");

  // A second edit in the same cell is an ordinary save: nothing unaligned.
  await cell.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.insertText(" Amen.");
  await cell.locator("xpath=..").locator('[aria-label="save edits"] button').click();
  await expect.poll(async () => (await fetchVerse()).plain_text).toContain("“the baby’s toy” Amen.");
  expect(alignedCount((await fetchVerse()).content)).toBe(alignedCount(before.content));

  await context.close();
});
