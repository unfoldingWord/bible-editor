import { expect, test, type Page } from "@playwright/test";
import { fetchChapter, newUserContext } from "./helpers";

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

// Hold one chapter's GET until released.
async function holdChapter(page: Page, chapter: number) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(new RegExp(`/api/chapters/ZEC/${chapter}(\\?|$)`), async (route) => {
    await gate;
    await route.continue().catch(() => {});
  });
  return release;
}

const setHash = (page: Page, hash: string) =>
  page.evaluate((h) => {
    window.location.hash = h;
  }, hash);

for (const mode of ["rows", "columns", "book"] as const) {
  test(`${mode}: the previous chapter stays visible and locked until the next one loads`, async ({ browser }) => {
    test.setTimeout(90_000);
    const { context, auth } = await newUserContext(browser, `stale892-${mode}`);
    const page = await context.newPage();

    // A verse of ZEC 6 that carries a note, so the note probe below always
    // has a card to aim at (ZEC 7 has 14 verses, ZEC 6 notes start early).
    const ch6 = await fetchChapter(context.request, auth.token, "ZEC", 6);
    const verse = ch6.tn.find((r) => r.verse > 0 && r.verse <= 14)?.verse;
    expect(verse, "ZEC 6 needs a note on a verse 1-14 for this test").toBeTruthy();

    await page.goto(`/#/ZEC/6/${verse}`);
    if (mode !== "rows") {
      await page.locator("button").filter({ hasText: new RegExp(`^${mode}$`) }).click();
    }
    const oldCell = page.locator(cellSel(mode, 6, verse!));
    await expect(oldCell).toHaveAttribute("contenteditable", "true", { timeout: 15_000 });
    const oldText = (await oldCell.textContent()) ?? "";
    expect(oldText.length).toBeGreaterThan(0);
    const before = await idbCounts(page);

    const release = await holdChapter(page, 7);
    await setHash(page, `#/ZEC/7/${verse}`);

    // Stale window: ZEC 6 is still on screen (no blank loading screen), the
    // split container is inert, no verse cell in it is editable, and a small
    // status line outside it says what is loading.
    const stale = page.locator('[data-stale-chapter="6"]');
    await expect(stale).toBeVisible();
    await expect(stale).toHaveAttribute("inert", "");
    await expect(oldCell).toBeVisible();
    await expect(stale.locator('[contenteditable="true"]')).toHaveCount(0);
    await expect(page.getByTestId("stale-chapter-status")).toContainText("loading ZEC 7");

    // Try to type into the old verse and into a note, the way a user would.
    // A real mouse click (not locator.click, which refuses an inert target).
    const box = await oldCell.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.keyboard.type(" STALE892", { delay: 20 });
    const note = stale.locator("[data-note-id]").first();
    await expect(note, "the stale view must show a note card to probe").toBeVisible();
    const nb = await note.boundingBox();
    expect(nb).not.toBeNull();
    await page.mouse.click(nb!.x + nb!.width / 2, nb!.y + Math.min(40, nb!.height / 2));
    await page.keyboard.type(" STALENOTE892", { delay: 20 });
    await page.waitForTimeout(500);

    expect(await oldCell.textContent(), "the stale verse text must not change").toBe(oldText);
    const probe = await page.evaluate(() => {
      const root = document.querySelector("[data-stale-chapter]");
      const areas = Array.from(root?.querySelectorAll("textarea, input") ?? []) as HTMLTextAreaElement[];
      return {
        focusInside: !!root && root.contains(document.activeElement),
        typedIntoField: areas.some((a) => a.value.includes("STALENOTE892")),
      };
    });
    expect(probe.focusInside, "focus must not enter the stale view").toBe(false);
    expect(probe.typedIntoField, "typed text must not reach a note field").toBe(false);
    const during = await idbCounts(page);
    expect(during.pendingOps, "no outbox op may be queued against the stale copy").toBe(before.pendingOps);
    expect(during.drafts, "no draft may be written for the stale copy").toBe(before.drafts);

    // The fresh chapter lands: the lock lifts and ZEC 7 is editable.
    release();
    await expect(page.locator("[data-stale-chapter]")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByTestId("stale-chapter-status")).toHaveCount(0);
    const newCell = page.locator(cellSel(mode, 7, verse!));
    await expect(newCell).toHaveAttribute("contenteditable", "true", { timeout: 15_000 });
    expect((await newCell.textContent()) ?? "").not.toContain("STALE892");
    await newCell.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type(" FRESH892", { delay: 20 });
    await expect(newCell).toContainText("FRESH892");

    // Drafts and the outbox live in this context only; nothing was saved.
    await context.close();
  });
}

// A → B → A before B lands: A's old copy matches the route again, but it may
// carry pre-save versions, so it stays locked until A's own new GET lands.
test("A → B → A: the old copy of A stays locked until A's new load lands", async ({ browser }) => {
  test.setTimeout(90_000);
  const { context } = await newUserContext(browser, "stale892-aba");
  const page = await context.newPage();
  await page.goto("/#/ZEC/8/1");
  const cellA = page.locator(cellSel("rows", 8, 1));
  await expect(cellA).toHaveAttribute("contenteditable", "true", { timeout: 15_000 });

  const releaseB = await holdChapter(page, 9);
  const releaseA = await holdChapter(page, 8);
  await setHash(page, "#/ZEC/9/1");
  await expect(page.locator('[data-stale-chapter="8"]')).toBeVisible();
  await setHash(page, "#/ZEC/8/1");
  await page.waitForTimeout(300);
  // Route is A again and A's data is on screen, but A's new GET is held.
  const stale = page.locator('[data-stale-chapter="8"]');
  await expect(stale).toBeVisible();
  await expect(stale).toHaveAttribute("inert", "");
  await expect(stale.locator('[contenteditable="true"]')).toHaveCount(0);
  await expect(page.getByTestId("stale-chapter-status")).toContainText("loading ZEC 8");

  releaseA();
  await expect(page.locator("[data-stale-chapter]")).toHaveCount(0, { timeout: 15_000 });
  await expect(cellA).toHaveAttribute("contenteditable", "true", { timeout: 15_000 });
  releaseB();
  await context.close();
});

// A save the user started on chapter N before navigating must land on
// chapter N, even when it completes while N is the stale copy on screen.
test("a verse save started before navigating lands on the chapter it was typed in", async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, auth } = await newUserContext(browser, "stale892-inflight");
  const page = await context.newPage();
  await page.goto("/#/ZEC/12/1");
  const cell = page.locator(cellSel("rows", 12, 1));
  await expect(cell).toHaveAttribute("contenteditable", "true", { timeout: 15_000 });
  const marker = ` INFLIGHT892-${Date.now()}`;
  await cell.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(marker, { delay: 20 });
  const save = page.locator('button:has([data-testid="SaveIcon"])').first();
  await expect(save).toBeVisible();

  // Hold ZEC 13 so the save's async draft lookup resolves while ZEC 12 is the
  // stale copy on screen.
  const release = await holdChapter(page, 13);
  await save.click();
  await setHash(page, "#/ZEC/13/1");
  await expect(page.locator('[data-stale-chapter="12"]')).toBeVisible();

  const verseText = async (chapter: number) => {
    const res = await context.request.get(`/api/chapters/ZEC/${chapter}`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    });
    const body = (await res.json()) as { verses?: Record<string, Record<string, { plain_text?: string }>> };
    return body.verses?.ULT?.["1"]?.plain_text ?? "";
  };
  await expect.poll(() => verseText(12), { timeout: 15_000 }).toContain(marker.trim());
  expect(await verseText(13), "the save must not be filed against the new chapter").not.toContain(marker.trim());

  release();
  await expect(page.locator("[data-stale-chapter]")).toHaveCount(0, { timeout: 15_000 });
  await context.close();
});

// A refetch captured on the chapter being left must not strand the lock. The
// "use automatic" (TWL order unlock) handler awaits the server and then calls
// the refetch it closed over; if the tab navigated meanwhile, that refetch
// used to GET the OLD chapter through the shared sequencer, replacing the new
// chapter's GET, so the view stayed locked on "loading ..." forever.
test("an old chapter's refetch after navigating does not leave the view locked", async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, auth } = await newUserContext(browser, "stale892-refetch");
  const page = await context.newPage();
  const ch10 = (await fetchChapter(context.request, auth.token, "ZEC", 10)) as unknown as {
    twl: Array<{ verse: number }>;
  };
  const verse = ch10.twl.find((r) => r.verse > 0)?.verse;
  expect(verse, "ZEC 10 needs a translationWords link on a real verse").toBeTruthy();
  // Take the verse's word order manual through the API so "use automatic" shows.
  const csrf = (await context.request.storageState()).cookies.find((c) => c.name === "be_csrf")?.value ?? "";
  const lockRes = await context.request.put(`/api/chapters/ZEC/10/twl-order-lock`, {
    headers: { Authorization: `Bearer ${auth.token}`, "x-csrf-token": csrf, "Content-Type": "application/json" },
    data: { verse },
  });
  expect(lockRes.ok(), `lock twl order: ${lockRes.status()}`).toBe(true);

  try {
    await page.goto(`/#/ZEC/10/${verse}`);
    await page.getByRole("button", { name: /^Words/ }).first().click();
    const useAutomatic = page.getByRole("button", { name: "use automatic" }).first();
    await expect(useAutomatic).toBeVisible({ timeout: 15_000 });

    // Hold the unlock's response and ZEC 11's GET, click, then navigate.
    let releaseUnlock!: () => void;
    const unlockGate = new Promise<void>((r) => (releaseUnlock = r));
    await page.route(/\/twl-order-lock\?verse=/, async (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      await unlockGate;
      await route.continue().catch(() => {});
    });
    const release11 = await holdChapter(page, 11);
    await useAutomatic.click();
    await setHash(page, "#/ZEC/11/1");
    await expect(page.locator('[data-stale-chapter="10"]')).toBeVisible();

    // The unlock finishes after the navigation; its refetch now runs.
    releaseUnlock();
    await page.waitForTimeout(500);
    release11();
    await expect(page.locator("[data-stale-chapter]")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator(cellSel("rows", 11, 1))).toHaveAttribute("contenteditable", "true", { timeout: 15_000 });
  } finally {
    // Hand the verse back to automatic ordering even if the test failed before
    // "use automatic" ran, so the shared fixture isn't left with a manual lock.
    await context.request
      .delete(`/api/chapters/ZEC/10/twl-order-lock?verse=${verse}`, {
        headers: { Authorization: `Bearer ${auth.token}`, "x-csrf-token": csrf },
      })
      .catch(() => {});
    await context.close();
  }
});

// Comments load separately from the chapter. Keyed on the route, the next
// chapter's threads arrived while the previous chapter was the locked copy on
// screen and painted onto its verse cells (round-4 review of #892). They must
// wait for their own chapter's payload.
test("the stale copy keeps its own comment badges, not the next chapter's", async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, auth } = await newUserContext(browser, "stale892-comments");
  const page = await context.newPage();
  const headers = { Authorization: `Bearer ${auth.token}`, "x-csrf-token": auth.csrf, "Content-Type": "application/json" };
  const created = await context.request.post("/api/comments", {
    headers,
    data: { book: "ZEC", chapter: 5, verse: 1, kind: "note", body: `STALE892-COMMENT-${Date.now()}` },
  });
  expect(created.ok(), `create comment: ${created.status()}`).toBe(true);
  const commentId = ((await created.json()) as { id: number }).id;
  // Badges that show a count (an empty badge's label is "Add an internal comment…").
  const labels = (scope: string) =>
    page.locator(`${scope} [data-comments-badge]:not([aria-label^="Add"])`).evaluateAll((els) =>
      els.map((e) => e.getAttribute("aria-label")),
    );

  try {
    // ZEC 4's own comments have loaded before the baseline is read.
    const ch4Comments = page.waitForResponse(/\/api\/comments\/ZEC\/4(\?|$)/, { timeout: 15_000 });
    await page.goto("/#/ZEC/4/1");
    await expect(page.locator(cellSel("rows", 4, 1))).toHaveAttribute("contenteditable", "true", { timeout: 15_000 });
    await ch4Comments;
    await page.waitForTimeout(300);
    const before = await labels("body");

    const release = await holdChapter(page, 5);
    await setHash(page, "#/ZEC/5/1");
    await expect(page.locator('[data-stale-chapter="4"]')).toBeVisible();
    // Long enough for ZEC 5's comments to arrive if anything requests them.
    await page.waitForTimeout(1500);
    expect(await labels("body"), "ZEC 5's thread must not badge ZEC 4's copy").toEqual(before);

    release();
    await expect(page.locator("[data-stale-chapter]")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('[data-comments-badge][aria-label$="note"]').first()).toBeVisible({ timeout: 15_000 });
  } finally {
    await context.request.delete(`/api/comments/${commentId}`, { headers }).catch(() => {});
    await context.close();
  }
});

// A → B → A keeps A's payload on screen the whole time, so the comments key
// never changes. A comment added to A while the tab's socket followed B must
// still show once A's fresh payload lands (round-5 review of #892).
test("A → B → A: a comment added to A during the B window shows after A lands", async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, auth } = await newUserContext(browser, "stale892-aba-comments");
  const page = await context.newPage();
  const headers = { Authorization: `Bearer ${auth.token}`, "x-csrf-token": auth.csrf, "Content-Type": "application/json" };
  let commentId: number | null = null;
  try {
    const aComments = page.waitForResponse(/\/api\/comments\/ZEC\/14(\?|$)/, { timeout: 15_000 });
    await page.goto("/#/ZEC/14/1");
    await expect(page.locator(cellSel("rows", 14, 1))).toHaveAttribute("contenteditable", "true", { timeout: 15_000 });
    await aComments;
    await page.waitForTimeout(300);
    // Counted badges on screen (an empty badge's label starts "Add …").
    const labels = () =>
      page.locator('[data-comments-badge]:not([aria-label^="Add"])').evaluateAll((els) =>
        els.map((e) => e.getAttribute("aria-label")).join("|"),
      );
    const before = await labels();

    const releaseB = await holdChapter(page, 1);
    const releaseA = await holdChapter(page, 14);
    await setHash(page, "#/ZEC/1/1");
    await expect(page.locator('[data-stale-chapter="14"]')).toBeVisible();
    // Someone adds a comment to A while this tab's socket is on B.
    const created = await context.request.post("/api/comments", {
      headers,
      data: { book: "ZEC", chapter: 14, verse: 1, kind: "note", body: `STALE892-ABA-${Date.now()}` },
    });
    expect(created.ok(), `create comment: ${created.status()}`).toBe(true);
    commentId = ((await created.json()) as { id: number }).id;
    await setHash(page, "#/ZEC/14/1");
    await expect(page.locator('[data-stale-chapter="14"]')).toBeVisible();

    releaseA();
    await expect(page.locator("[data-stale-chapter]")).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(labels, { timeout: 10_000, message: "A's new comment must show after A lands" }).not.toBe(before);
    releaseB();
  } finally {
    if (commentId != null) await context.request.delete(`/api/comments/${commentId}`, { headers }).catch(() => {});
    await context.close();
  }
});

// A comment link into A that arrives during A → B → A, for a comment created
// while the tab was on B: A's old comment list doesn't have it yet, but the
// link must wait for the lock to lift (and the comments reload), not be
// consumed as "no longer available" (round-6 review of #892).
test("A → B → A: a comment link into A waits for A to land instead of reporting it gone", async ({ browser }) => {
  test.setTimeout(90_000);
  const { context, auth } = await newUserContext(browser, "stale892-aba-link");
  const page = await context.newPage();
  const headers = { Authorization: `Bearer ${auth.token}`, "x-csrf-token": auth.csrf, "Content-Type": "application/json" };
  const body = `STALE892-LINK-${Date.now()}`;
  let commentId: number | null = null;
  try {
    const aComments = page.waitForResponse(/\/api\/comments\/ZEC\/14(\?|$)/, { timeout: 15_000 });
    await page.goto("/#/ZEC/14/1");
    await expect(page.locator(cellSel("rows", 14, 1))).toHaveAttribute("contenteditable", "true", { timeout: 15_000 });
    await aComments;

    const releaseB = await holdChapter(page, 1);
    const releaseA = await holdChapter(page, 14);
    await setHash(page, "#/ZEC/1/1");
    await expect(page.locator('[data-stale-chapter="14"]')).toBeVisible();
    const created = await context.request.post("/api/comments", {
      headers,
      data: { book: "ZEC", chapter: 14, verse: 1, kind: "question", body },
    });
    expect(created.ok(), `create comment: ${created.status()}`).toBe(true);
    commentId = ((await created.json()) as { id: number }).id;
    await setHash(page, `#/ZEC/14/1?c=${commentId}`);
    await expect(page.locator('[data-stale-chapter="14"]')).toBeVisible();
    await page.waitForTimeout(1000);
    await expect(page.getByText("That comment is no longer available.")).toHaveCount(0);

    releaseA();
    await expect(page.locator("[data-stale-chapter]")).toHaveCount(0, { timeout: 15_000 });
    await expect(page.getByText(body).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText("That comment is no longer available.")).toHaveCount(0);
    releaseB();
  } finally {
    if (commentId != null) await context.request.delete(`/api/comments/${commentId}`, { headers }).catch(() => {});
    await context.close();
  }
});
