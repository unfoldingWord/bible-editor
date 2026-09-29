import { expect, test, type Page } from "@playwright/test";
import { newUserContext } from "./helpers";

// S16 — issue #892 (Benjamin's option B): on a chapter change the previous
// chapter stays on screen, LOCKED, until the fresh chapter lands, in every
// scripture mode. The #531 rule still holds: nothing typed into the old copy
// may reach the draft store or the outbox. The chapter GET is held open by a
// route gate so the stale window is as long as the test needs, not a race.

const cellSel = (mode: "rows" | "columns" | "book", chapter: number, verse: number) =>
  mode === "rows"
    ? `[data-find-cell="${chapter}-${verse}-ULT"]`
    : `[data-find-cell="${chapter}-${verse}-ULT"] [contenteditable]`;

async function idbCounts(page: Page) {
  return page.evaluate(async () => {
    const open = (name: string, version: number) =>
      new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(name, version);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    // Never create a store-less DB by probing one the app hasn't opened yet:
    // that would stop the app's own upgrade from ever running.
    const existing = new Set((await indexedDB.databases()).map((d) => d.name));
    const all = async (dbName: string, store: string) => {
      if (!existing.has(dbName)) return [];
      const db = await open(dbName, 1);
      try {
        return await new Promise<unknown[]>((resolve, reject) => {
          const req = db.transaction(store, "readonly").objectStore(store).getAll();
          req.onsuccess = () => resolve(req.result as unknown[]);
          req.onerror = () => reject(req.error);
        });
      } catch {
        return [];
      } finally {
        db.close();
      }
    };
    const ops = (await all("bible-editor-outbox", "ops")) as Array<{ status: string }>;
    const drafts = await all("bible-editor-drafts", "drafts");
    return {
      pendingOps: ops.filter((o) => o.status === "pending" || o.status === "in_flight").length,
      drafts: drafts.length,
    };
  });
}

for (const mode of ["rows", "columns", "book"] as const) {
  test(`${mode}: the previous chapter stays visible and locked until the next one loads`, async ({ browser }) => {
    test.setTimeout(90_000);
    const { context } = await newUserContext(browser, `stale892-${mode}`);
    const page = await context.newPage();

    await page.goto("/#/ZEC/6/2");
    if (mode !== "rows") {
      await page.locator("button").filter({ hasText: new RegExp(`^${mode}$`) }).click();
    }
    const oldCell = page.locator(cellSel(mode, 6, 2));
    await expect(oldCell).toHaveAttribute("contenteditable", "true", { timeout: 15_000 });
    const oldText = (await oldCell.textContent()) ?? "";
    expect(oldText.length).toBeGreaterThan(0);
    const before = await idbCounts(page);

    // Hold ZEC 7's chapter GET until released.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await page.route(/\/api\/chapters\/ZEC\/7(\?|$)/, async (route) => {
      await gate;
      await route.continue();
    });

    await page.evaluate(() => {
      window.location.hash = "#/ZEC/7/2";
    });

    // Stale window: ZEC 6 is still on screen (no blank loading screen), the
    // split container is inert, and no verse cell in it is editable.
    const stale = page.locator('[data-stale-chapter="6"]');
    await expect(stale).toBeVisible();
    await expect(stale).toHaveAttribute("inert", "");
    await expect(oldCell).toBeVisible();
    await expect(page.getByText(/^loading ZEC 7/)).toHaveCount(0);
    await expect(stale.locator('[contenteditable="true"]')).toHaveCount(0);

    // Try to type into the old verse and into a note, the way a user would.
    // A real mouse click (not locator.click, which refuses an inert target).
    const box = await oldCell.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.keyboard.type(" STALE892", { delay: 20 });
    const note = stale.locator("[data-note-id]").first();
    if (await note.count()) {
      const nb = await note.boundingBox();
      if (nb) {
        await page.mouse.click(nb.x + nb.width / 2, nb.y + Math.min(40, nb.height / 2));
        await page.keyboard.type(" STALENOTE892", { delay: 20 });
      }
    }
    await page.waitForTimeout(500);

    expect(await oldCell.textContent(), "the stale verse text must not change").toBe(oldText);
    // Nothing inside the stale view took focus or the typed note text.
    const probe = await page.evaluate(() => {
      const root = document.querySelector("[data-stale-chapter]");
      const areas = Array.from(root?.querySelectorAll("textarea, input") ?? []) as HTMLTextAreaElement[];
      return {
        focusInside: !!root && root.contains(document.activeElement),
        typedIntoField: areas.some((a) => a.value.includes("STALENOTE892")),
        textareas: areas.filter((a) => a.tagName === "TEXTAREA" && !a.getAttribute("aria-hidden")).length,
      };
    });
    console.log(`[s16 ${mode}] stale probe`, JSON.stringify(probe));
    expect(probe.focusInside, "focus must not enter the stale view").toBe(false);
    expect(probe.typedIntoField, "typed text must not reach a note field").toBe(false);
    const during = await idbCounts(page);
    expect(during.pendingOps, "no outbox op may be queued against the stale copy").toBe(before.pendingOps);
    expect(during.drafts, "no draft may be written for the stale copy").toBe(before.drafts);

    // The fresh chapter lands: the lock lifts and ZEC 7 is editable.
    release();
    await expect(page.locator("[data-stale-chapter]")).toHaveCount(0, { timeout: 15_000 });
    const newCell = page.locator(cellSel(mode, 7, 2));
    await expect(newCell).toHaveAttribute("contenteditable", "true", { timeout: 15_000 });
    const newText = (await newCell.textContent()) ?? "";
    expect(newText).not.toContain("STALE892");
    await newCell.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(" FRESH892", { delay: 20 });
    await expect(newCell).toContainText("FRESH892");

    // Drafts and the outbox live in this context only; nothing was saved.
    await context.close();
  });
}
