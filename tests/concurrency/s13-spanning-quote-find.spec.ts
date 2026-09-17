import { expect, test } from "@playwright/test";
import { collectBareWords } from "../../web/src/lib/highlight";
import { gotoVerse, newUserContext } from "./helpers";

// Merge regression: spanning-note paint from #804 must coexist with #805's
// layout-preserving Find, including an inactive stacked verse with word marks.
test("spanning quote highlights survive silent multi-word Find in every mode", async ({ browser }, testInfo) => {
  const { context, auth } = await newUserContext(browser, "spanning-find");
  try {
    const chapterResponse = await context.request.get("/api/chapters/ZEC/1");
    expect(chapterResponse.ok()).toBe(true);
    const chapter = await chapterResponse.json();
    const quote = [2, 3].map((verse) => collectBareWords(chapter.verses.UHB[verse].content.verseObjects)
      .map((word) => word.text).join(" ")).join(" & ");
    const createdResponse = await context.request.post("/api/rows/tn", {
      headers: { "x-csrf-token": auth.csrf },
      data: { book: "ZEC", chapter: 1, verse: 2, ref_raw: "1:2-3", quote, occurrence: 1,
        note: `spanning-find-merge-${Date.now()}` },
    });
    expect(createdResponse.status()).toBe(201);
    const created = await createdResponse.json();
    const page = await context.newPage();
    await gotoVerse(page, "ZEC", 1, 2);
    const card = page.locator(`[data-note-id="${created.id}"]`);
    await card.getByTitle("click to edit", { exact: true }).click();

    for (const mode of ["rows", "columns", "book"]) {
      await page.locator("button").filter({ hasText: new RegExp(`^${mode}$`) }).click();
      const nextVerse = page.locator('[data-find-cell="1-3-ULT"]').first();
      await expect.poll(() => nextVerse.locator("mark.be-hl").count()).toBeGreaterThan(0);
      await page.getByRole("button", { name: "find", exact: true }).click();
      await page.waitForTimeout(700);
      const geometry = () => nextVerse.evaluate((el) => {
        const offsets = [];
        for (let parent = el.parentElement; parent; parent = parent.parentElement) {
          if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY)) offsets.push(parent.scrollTop);
        }
        return { height: el.getBoundingClientRect().height, offsets };
      });
      const before = await geometry();
      await testInfo.attach(`${mode}-before`, { body: await page.screenshot(), contentType: "image/png" });
      await page.getByPlaceholder("find").fill("And you");
      // The phrase spans individually highlighted alignment words. Find must
      // render it as a complete match rather than dropping a split text run.
      await expect(nextVerse.locator("mark.be-find").filter({ hasText: /^And you$/ })).toHaveCount(1);
      expect(await geometry()).toEqual(before);
      await expect(page.getByText(/^ZEC 1:2$/).first()).toBeVisible();
      await testInfo.attach(`${mode}-after`, { body: await page.screenshot(), contentType: "image/png" });
      await testInfo.attach(`${mode}-aria`, { body: await page.locator("body").ariaSnapshot(), contentType: "text/plain" });
      await page.getByPlaceholder("find").press("Escape");
      await expect.poll(() => nextVerse.locator("mark.be-hl").count()).toBeGreaterThan(0);
    }

    // The merged picker must still expose every covered source verse.
    await card.locator("button").filter({ hasText: /^build from source$/ }).click();
    await expect(page.getByText("Build quote · ZEC 1:2–3", { exact: true })).toBeVisible();
    const picker = page.locator(".MuiPopper-root").filter({ hasText: "Build quote" });
    await expect(picker.getByText("v2", { exact: true })).toBeVisible();
    await expect(picker.getByText("v3", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
  } finally {
    await context.close();
  }
});
