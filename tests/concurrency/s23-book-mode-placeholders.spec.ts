import { expect, test, type Page } from "@playwright/test";
import { newUserContext } from "./helpers";

// S23 — issue #1120: book mode lets the browser skip layout for chapters far
// off screen (`content-visibility: auto`, #909 step 1). A skipped chapter is
// sized by a placeholder: the browser's remembered size of its last layout,
// or an estimate if it was never laid out. When the placeholder is wrong, the
// chapter changes height the moment it is laid out again, and in a browser
// without scroll anchoring (Safari) everything below it jumps while the
// reader scrolls. Two ways it went wrong:
//   1. After a version column was toggled, chapters rendered once and then
//      skipped kept their pre-toggle height.
//   2. Chapters loaded but never laid out (the pre-loader fetches them before
//      they come on screen) sat at an estimate: a 150 px-per-row fallback if
//      they loaded before the active chapter was measured.
//
// What this guards: every loaded chapter's shown height equals the height it
// has when laid out in full, after a column toggle and after a far jump; and,
// with scroll anchoring turned off as in Safari, the verse row at the top of
// the view stays put across a toggle (a toggle re-lays out every chapter
// above it at once, which without BookView's ColumnToggleAnchor moved the
// view by thousands of pixels).

const BOOK = "ZEC";

// Per loaded chapter: the shown height (maybe a placeholder) against the real
// laid-out height. Read in one synchronous task, so the forced layout never
// reaches a rendering update and cannot change any remembered size.
async function wrongPlaceholders(page: Page): Promise<{ chapter: number; errPx: number }[]> {
  return page.evaluate(() => {
    const blocks = [...document.querySelectorAll<HTMLElement>("[data-chapter-block]")];
    const shown = blocks.map((b) => b.getBoundingClientRect().height);
    const s = document.createElement("style");
    s.textContent = "[data-chapter-block]{content-visibility:visible !important}";
    document.head.appendChild(s);
    const real = blocks.map((b) => b.getBoundingClientRect().height);
    s.remove();
    return blocks
      .map((b, i) => ({ chapter: Number(b.dataset.chapterBlock), errPx: Math.round(shown[i] - real[i]) }))
      .filter((e) => Math.abs(e.errPx) > 1);
  });
}

// The verse row at the top of the scroll box: its chapter-verse and offset.
async function topRow(page: Page): Promise<{ id: string; offset: number }> {
  const row = await page.evaluate(() => {
    let el = document.querySelector("[data-chapter-block]")?.parentElement ?? null;
    while (el && getComputedStyle(el).overflowY !== "auto") el = el.parentElement;
    if (!el) return null;
    const top = el.getBoundingClientRect().top;
    for (const c of el.querySelectorAll<HTMLElement>("[data-find-cell]")) {
      const r = c.getBoundingClientRect();
      if (r.height === 0 || r.bottom <= top) continue;
      const [ch, v] = (c.dataset.findCell ?? "").split("-");
      return { id: `${ch}-${v}`, offset: r.top - top };
    }
    return null;
  });
  expect(row).not.toBeNull();
  return row!;
}

// How far that row has moved since `before` was read.
async function topRowMovedPx(page: Page, before: { id: string; offset: number }): Promise<number> {
  return page.evaluate(({ id, offset }) => {
    let el = document.querySelector("[data-chapter-block]")?.parentElement ?? null;
    while (el && getComputedStyle(el).overflowY !== "auto") el = el.parentElement;
    const c = el?.querySelector(`[data-find-cell^="${id}-"]`);
    if (!el || !c) return Number.POSITIVE_INFINITY;
    return Math.round(c.getBoundingClientRect().top - el.getBoundingClientRect().top - offset);
  }, before);
}

async function scroller(page: Page) {
  return page.evaluateHandle(() => {
    let el = document.querySelector("[data-chapter-block]")?.parentElement ?? null;
    while (el && getComputedStyle(el).overflowY !== "auto") el = el.parentElement;
    return el as HTMLElement;
  });
}

// Settled: nothing loading and the scroll box unchanged for ~1 s.
async function settle(page: Page) {
  await expect
    .poll(
      async () => {
        const sig = () =>
          page.evaluate(() => {
            let el = document.querySelector("[data-chapter-block]")?.parentElement ?? null;
            while (el && getComputedStyle(el).overflowY !== "auto") el = el.parentElement;
            return `${el?.scrollTop}|${el?.scrollHeight}|${document.body.innerText.includes("loading…")}`;
          });
        const a = await sig();
        await page.waitForTimeout(1000);
        return a === (await sig()) && !a.endsWith("true");
      },
      { timeout: 30_000, intervals: [0] },
    )
    .toBe(true);
}

async function openBookMode(page: Page, chapter: number) {
  await page.goto(`/#/${BOOK}/${chapter}/1`);
  await page.locator("[data-find-cell]").first().waitFor({ state: "attached", timeout: 15_000 });
  await page.locator("button").filter({ hasText: /^book$/ }).click();
  await page.locator("[data-chapter-block]").first().waitFor({ state: "attached", timeout: 15_000 });
  await settle(page);
}

test.describe("S23 — book-mode placeholder heights (#1120)", () => {
  test.setTimeout(180_000);

  test("after a column toggle, every loaded chapter keeps its real height", async ({ browser }) => {
    const { context } = await newUserContext(browser, "s23-toggle");
    await context.addInitScript(() => {
      try {
        if (!sessionStorage.getItem("s23")) {
          sessionStorage.setItem("s23", "1");
          localStorage.setItem("be:enabledVersions", JSON.stringify(["ULT", "UST"]));
        }
      } catch {
        /* private mode */
      }
      // No scroll anchoring, as in Safari: nothing absorbs a height change
      // above the view, so the top-row checks below see every jump.
      document.addEventListener("DOMContentLoaded", () => {
        const s = document.createElement("style");
        s.textContent = "*{overflow-anchor:none !important}";
        document.head.appendChild(s);
      });
    });
    const page = await context.newPage();
    await page.setViewportSize({ width: 1400, height: 900 });
    await openBookMode(page, 1);
    // Scroll the whole book so every chapter loads and is laid out once.
    const sc = await scroller(page);
    for (let i = 0; i < 200; i++) {
      const done = await sc.evaluate((el) => {
        el.scrollTop += 700;
        return (
          el.scrollTop + el.clientHeight >= el.scrollHeight - 2 &&
          !document.body.innerText.includes("(scroll to load)") &&
          !document.body.innerText.includes("loading…")
        );
      });
      await page.waitForTimeout(120);
      if (done) break;
    }
    await settle(page);
    // The whole book must be loaded, or the checks below skip chapters.
    await expect(page.getByText("(scroll to load)")).toHaveCount(0);
    await expect(page.getByText(/loading…/)).toHaveCount(0);
    const caption = (await page.getByText(/ch · loaded/).first().textContent()) ?? "";
    const [, total, loaded] = caption.match(/(\d+) ch · loaded (\d+)/) ?? [];
    expect(Number(loaded)).toBeGreaterThan(0);
    expect(loaded).toBe(total);
    await page.evaluate(() => {
      location.hash = "#/ZEC/14/5";
    });
    await settle(page);
    expect(await wrongPlaceholders(page)).toEqual([]);

    const versions = page.getByRole("group", { name: "visible versions" });
    const topOn = await topRow(page);
    await versions.getByRole("button", { name: "UHB", exact: true }).click();
    await settle(page);
    expect(Math.abs(await topRowMovedPx(page, topOn))).toBeLessThan(50);
    expect(await wrongPlaceholders(page)).toEqual([]);

    const topOff = await topRow(page);
    await versions.getByRole("button", { name: "UHB", exact: true }).click();
    await settle(page);
    expect(Math.abs(await topRowMovedPx(page, topOff))).toBeLessThan(50);
    expect(await wrongPlaceholders(page)).toEqual([]);
    await context.close();
  });

  test("chapters loaded but never shown are sized at their real height", async ({ browser }) => {
    const { context } = await newUserContext(browser, "s23-firstwave");
    const page = await context.newPage();
    await page.setViewportSize({ width: 1400, height: 900 });
    await openBookMode(page, 1);
    await page.evaluate(() => {
      location.hash = "#/ZEC/12/1";
    });
    await settle(page);
    expect(await wrongPlaceholders(page)).toEqual([]);
    await context.close();
  });
});
