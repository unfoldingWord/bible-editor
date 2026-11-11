import { expect, test, type Locator, type Page } from "@playwright/test";
import { newUserContext } from "./helpers";

// S26 — issue #1279: a verse save curls straight quotes (#1273), so the stored
// text can hold ’ where the editor typed '. The editor must end up showing the
// curled text, or a later edit diffs ' against ’ and unaligns that word.
//   1. Rows mode: a paste whose only change is ' for ’ is a no-op save (no
//      PATCH). The cell must still repaint with ’, and a following edit on
//      both sides of that word keeps it aligned with no unalign confirm.
//   2. Dual aligner reading line: a save of a straight ' (a real edit, or a
//      quote-only paste that saves nothing) leaves the line showing ’, and
//      typing then undoing a character does not mark it dirty.
// The line's resync is skipped while it has focus, so a save that kept the
// caret in the line would leave ' on screen. While reproducing #1279 only a
// scripted button.click() did that (line kept ', type-and-undo marked it
// dirty, close prompted). A mouse click on Save moves focus off the line in
// Chromium, and clicking straight back in still finds the curled text: the
// save applies locally before the click lands.

const UST_615 = { chapter: 6, verse: 15, bv: "UST" };
const ULT_72 = { chapter: 7, verse: 2, bv: "ULT" };
const ULT_615 = { chapter: 6, verse: 15, bv: "ULT" };
type Ref = typeof UST_615;
const versePath = (r: Ref) => `/api/verses/ZEC/${r.chapter}/${r.verse}/${r.bv}`;

type VerseRow = { version: number; plain_text: string; content_json: string };

// Words inside an alignment milestone. `Yahweh’s` is stored as an aligned
// \w Yahweh plus a "’s" text node, so the whole verse's count is what a
// rewrite of that word would lower.
function alignedCount(content: unknown): number {
  let n = 0;
  const walk = (nodes: unknown[] | undefined, inZaln: boolean) => {
    for (const node of nodes ?? []) {
      const o = node as { tag?: string; type?: string; children?: unknown[] } | null;
      if (!o) continue;
      if (o.type === "word" && inZaln) n++;
      if (Array.isArray(o.children)) walk(o.children, inZaln || o.tag === "zaln");
    }
  };
  walk((content as { verseObjects?: unknown[] }).verseObjects, false);
  return n;
}

// Select `len` characters of `el`'s text starting at the first occurrence of
// `needle` plus `offset`.
async function selectText(page: Page, el: Locator, needle: string, offset: number, len: number) {
  await el.evaluate(
    (node, { needle, offset, len }) => {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        const i = (t.textContent ?? "").indexOf(needle);
        if (i < 0) continue;
        const range = document.createRange();
        range.setStart(t, i + offset);
        range.setEnd(t, i + offset + len);
        const sel = window.getSelection()!;
        sel.removeAllRanges();
        sel.addRange(range);
        return;
      }
      throw new Error(`"${needle}" not found in a single text node`);
    },
    { needle, offset, len },
  );
  void page;
}

for (const mode of ["stacked", "columns", "book"] as const) {
  test(`${mode} mode: a quote-only paste repaints the curled text, and a two-sided edit keeps that word aligned`, async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const { context } = await newUserContext(browser, `curl1279${mode}`);
    await context.addInitScript((m) => localStorage.setItem("be:scriptureMode", JSON.stringify(m)), mode);
    const page = await context.newPage();
    const serverVerse = async (): Promise<VerseRow> => {
      const res = await context.request.get(versePath(UST_615));
      expect(res.ok()).toBe(true);
      return (await res.json()) as VerseRow;
    };
    const before = await serverVerse();
    expect(before.plain_text).toContain("Yahweh’s temple");
    const alignedBefore = alignedCount(JSON.parse(before.content_json));
    expect(alignedBefore).toBeGreaterThan(0);

    const patches: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "PATCH" && req.url().includes(versePath(UST_615))) patches.push(req.url());
    });

    await page.goto(`/#/ZEC/${UST_615.chapter}/${UST_615.verse}`);
    const anyCell = page.locator('[data-find-cell="6-15-UST"]').first();
    await anyCell.waitFor({ timeout: 15_000 });
    await anyCell.click();
    const cell = page
      .locator('[data-find-cell="6-15-UST"][contenteditable="true"], [data-find-cell="6-15-UST"] [contenteditable="true"]')
      .first();
    await cell.waitFor({ timeout: 10_000 });
    const saveButton = () =>
      mode === "stacked"
        ? cell.locator("xpath=..").locator('[aria-label="save edits"] button')
        : page.getByRole("button", { name: "save verse 15" }).first();

    // Select the stored `’s` of `Yahweh’s` and paste a straight `'s` over it.
    await cell.click();
    await selectText(page, cell, "Yahweh’s", "Yahweh".length, 2);
    await page.keyboard.insertText("'s");
    await expect(cell).toContainText("Yahweh's temple");
    await page.waitForTimeout(500);
    await saveButton().click();
    // Let any repaint / queued PATCH land.
    await page.waitForTimeout(1500);
    const shown = (await cell.textContent()) ?? "";
    const dirtyAttr = await cell.getAttribute("data-dirty");
    console.log(`[s28] ${mode} case1 PATCHes:`, patches.length, "| cell shows:", shown.match(/Yahweh.s/)?.[0], "| data-dirty:", dirtyAttr);
    expect.soft(patches.length, "a quote-only change is a no-op save").toBe(0);
    expect.soft(shown, "the cell repaints with the stored curly form").toContain("Yahweh’s temple");

    // Now edit on BOTH sides of that word in one save.
    const unalignConfirm = page.getByRole("dialog").filter({ hasText: /will be unaligned/ });
    await cell.click();
    await page.keyboard.press("ControlOrMeta+Home");
    await page.keyboard.insertText("Then ");
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.insertText(" Amen.");
    await page.waitForTimeout(500);
    await saveButton().click();
    const confirmShown = await unalignConfirm
      .waitFor({ state: "visible", timeout: 2500 })
      .then(() => true)
      .catch(() => false);
    if (confirmShown) await unalignConfirm.getByRole("button", { name: /save anyway/i }).click();
    await expect.poll(async () => (await serverVerse()).version).toBeGreaterThan(before.version);
    const after = await serverVerse();
    const alignedAfter = alignedCount(JSON.parse(after.content_json));
    console.log(`[s28] ${mode} case1 two-sided edit: confirm shown:`, confirmShown, "| aligned words before/after:", alignedBefore, alignedAfter, "|", after.plain_text);
    expect.soft(confirmShown, "no unalign confirm for edits that do not touch Yahweh’s").toBe(false);
    expect.soft(alignedAfter, "the two-sided edit unaligns nothing").toBe(alignedBefore);
    await context.close();
  });
}

for (const variant of [
  // A real edit typed at the end: saved, and curled by the save.
  { name: "typed edit", ref: ULT_72, needle: null, insert: " the dog's bone", patches: 1, shows: "the dog’s bone", backAtOnce: false },
  // The same, clicking straight back into the line after Save, so the line
  // may be focused again by the time the saved text reaches it.
  { name: "typed edit, straight back into the line", ref: ULT_72, needle: null, insert: " a cat's tail", patches: 1, shows: "a cat’s tail", backAtOnce: true },
  // Only ’ → ' (with the ! before it, so the insert is multi-character and
  // the typing interceptor does not curl it): a no-op save.
  { name: "quote-only paste", ref: ULT_615, needle: "God!’", insert: "!'", patches: 0, shows: "God!’”", backAtOnce: false },
]) {
  test(`dual aligner (${variant.name}): after Save the reading line shows the curled text and stays clean`, async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const r = variant.ref;
    const { context } = await newUserContext(browser, `curl1279dual${variant.patches}${variant.backAtOnce ? "b" : ""}`);
    const page = await context.newPage();
    const serverVerse = async (): Promise<VerseRow> => {
      const res = await context.request.get(versePath(r));
      expect(res.ok()).toBe(true);
      return (await res.json()) as VerseRow;
    };
    const before = await serverVerse();
    const patches: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "PATCH" && req.url().includes(versePath(r))) patches.push(req.url());
    });

    await page.goto(`/#/ZEC/${r.chapter}/${r.verse}`);
    await page.locator(`[data-find-cell="${r.chapter}-${r.verse}-ULT"]`).first().waitFor({ timeout: 15_000 });
    await page.locator(`button[aria-label^="align ULT"]`).first().click();
    const sideBySide = page.locator("button", { hasText: "Side-by-side" }).first();
    await sideBySide.waitFor({ state: "visible" });
    await sideBySide.click();
    const dialog = page.getByRole("dialog").filter({ hasText: "reading text" });
    const editable = dialog.locator('[contenteditable="true"]:visible');
    await editable.first().waitFor({ state: "visible" });
    await editable.first().evaluate((el) => el.setAttribute("data-s28-line", "ULT"));
    const line = dialog.locator('[data-s28-line="ULT"]');
    const lineBox = line.locator("..");
    const save = lineBox.getByRole("button", { name: "Save ULT", exact: true });

    await line.click();
    if (variant.needle) await selectText(page, line, variant.needle, variant.needle.length - 2, 2);
    else await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.insertText(variant.insert);
    await expect(save).toBeEnabled();
    await save.click();
    if (variant.backAtOnce) await line.click();
    if (variant.patches > 0) {
      await expect.poll(async () => (await serverVerse()).version).toBeGreaterThan(before.version);
    }
    await page.waitForTimeout(1500);
    const shown = (await line.textContent()) ?? "";
    const focused = await line.evaluate((el) => document.activeElement === el);
    console.log(`[s28] dual ${variant.name}: PATCHes:`, patches.length, "| line focused:", focused, "| line ends:", shown.slice(-20));

    // Type a character and delete it in the line.
    await line.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("x");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(300);
    const dirtyAfterUndo = await save.isEnabled();
    await dialog.getByRole("button", { name: "close", exact: true }).click();
    const gate = page.getByRole("dialog").filter({ hasText: "Unsaved changes" });
    const gateShown = await gate
      .waitFor({ state: "visible", timeout: 1500 })
      .then(() => true)
      .catch(() => false);
    console.log(`[s28] dual ${variant.name}: Save enabled after type-and-undo:`, dirtyAfterUndo, "| unsaved prompt on close:", gateShown);
    expect.soft(patches.length).toBe(variant.patches);
    expect.soft(shown, "the line shows the curled text after its save").toContain(variant.shows);
    expect.soft(shown).not.toMatch(/['"]/);
    expect.soft(dirtyAfterUndo, "type-and-undo leaves the line clean").toBe(false);
    expect.soft(gateShown, "no unsaved-changes prompt").toBe(false);
    await context.close();
  });
}
