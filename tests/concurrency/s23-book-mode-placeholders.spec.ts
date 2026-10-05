import { expect, test, type Page } from "@playwright/test";
import { newUserContext } from "./helpers";

// S22 — issue #1120: book mode lets the browser skip layout for chapters far
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
// has when laid out in full, after a column toggle and after a far jump.

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

test.describe("S22 — book-mode placeholder heights (#1120)", () => {
  test.setTimeout(180_000);

  test("after a column toggle, every loaded chapter keeps its real height", async ({ browser }) => {
    const { context } = await newUserContext(browser, "s22-toggle");
    await context.addInitScript(() => {
      try {
        if (!sessionStorage.getItem("s22")) {
          sessionStorage.setItem("s22", "1");
          localStorage.setItem("be:enabledVersions", JSON.stringify(["ULT", "UST"]));
        }
      } catch {
        /* private mode */
      }
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
    await page.evaluate(() => {
      location.hash = "#/ZEC/14/5";
    });
    await settle(page);
    expect(await wrongPlaceholders(page)).toEqual([]);

    const versions = page.getByRole("group", { name: "visible versions" });
    await versions.getByRole("button", { name: "UHB", exact: true }).click();
    await settle(page);
    expect(await wrongPlaceholders(page)).toEqual([]);

    await versions.getByRole("button", { name: "UHB", exact: true }).click();
    await settle(page);
    expect(await wrongPlaceholders(page)).toEqual([]);
    await context.close();
  });

  test("chapters loaded but never shown are sized at their real height", async ({ browser }) => {
    const { context } = await newUserContext(browser, "s22-firstwave");
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
