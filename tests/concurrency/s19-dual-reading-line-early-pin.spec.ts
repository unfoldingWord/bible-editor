import { expect, test, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { csrfToken, newUserContext } from "./helpers";

// S19 — issue #1060: the dual aligner's reading line writes no keystroke
// draft, so it used to take its verse-base pin only inside the save
// (saveVerseDraft → pinVerseBase), not on the first keystroke the way the
// main scripture cells do through the draft store. A verse change that landed
// while the translator typed in a FOCUSED reading line (the unfocused resync
// never overwrites a focused box) was then pinned by Save, the stale on-screen
// text was diffed against it, and the PATCH carried a valid If-Match: the
// other change was silently reverted instead of a 409 and a merge prompt.
//
// What this guards:
//   1. The pin is taken on the first keystroke, from the version the box was
//      last synced from. Saving after a mid-edit server change sends that old
//      version and gets a 409; the server keeps the other change.
//   2. The pin goes as soon as the line goes clean (Undo, typed back by hand,
//      the verse moving onto the line's own text): a new edit saved after the
//      verse moved again lands with a 200, never a 409 from a leaked pin.
//   3. #1067: a verse change never replaces unsaved text on screen, focused or
//      not. A line that lost focus keeps its edit and its pin, so Save is a
//      409 and a merge prompt, not an overwrite.
//
// Kept apart from s18 (book locks) so the two suites can change separately.

const BOOK = "ZEC";
const BV = "ULT";
// ZEC 7:2 ULT for the text checks; ZEC 6:2 ULT (its aligned "horses", as in
// s17) for the alignment-save check.
type Ref = { chapter: number; verse: number };
const V72: Ref = { chapter: 7, verse: 2 };
const V62: Ref = { chapter: 6, verse: 2 };
const pinKey = (r: Ref) => `verse:${BOOK}:${r.chapter}:${r.verse}:${BV}`;
const versePath = (r: Ref) => `/api/verses/${BOOK}/${r.chapter}/${r.verse}/${BV}`;

type VerseRow = { version: number; plain_text: string; content_json: string };

async function serverVerse(request: APIRequestContext, r: Ref = V72): Promise<VerseRow> {
  const res = await request.get(versePath(r));
  expect(res.ok()).toBe(true);
  return (await res.json()) as VerseRow;
}

// Write the verse over the API, as another editor (or a reimport) would.
async function putVerse(request: APIRequestContext, csrf: string, content: unknown, plain: string, r: Ref = V72) {
  const cur = await serverVerse(request, r);
  const res = await request.patch(versePath(r), {
    headers: { "x-csrf-token": csrf, "If-Match": String(cur.version) },
    data: { content, plain_text: plain },
  });
  expect(res.status(), await res.text()).toBe(200);
  return ((await res.json()) as { version: number }).version;
}

// drafts.ts's DEV-only test hook.
type PinDebugWindow = {
  __bePinDebug?: {
    peek: (key: string) => { version: number } | undefined;
    currentVersion: (key: string) => number | undefined;
  };
};

async function pinnedVersion(page: Page, r: Ref = V72): Promise<number | undefined> {
  return page.evaluate((key) => (window as unknown as PinDebugWindow).__bePinDebug?.peek(key)?.version, pinKey(r));
}

async function cachedVersion(page: Page, r: Ref = V72): Promise<number | undefined> {
  return page.evaluate((key) => (window as unknown as PinDebugWindow).__bePinDebug?.currentVersion(key), pinKey(r));
}

// Statuses of this page's queued ops for the verse (outbox IndexedDB).
async function verseOpStatuses(page: Page, r: Ref = V72): Promise<string[]> {
  return page.evaluate(
    async ({ book, chapter, verse, bv }) => {
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const req = indexedDB.open("bible-editor-outbox", 1);
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      const ops = await new Promise<
        { status: string; target: { kind: string; book?: string; chapter?: number; verse?: number; bibleVersion?: string } }[]
      >((res, rej) => {
        const req = db.transaction("ops", "readonly").objectStore("ops").getAll();
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
      db.close();
      return ops
        .filter(
          (o) =>
            o.target.kind === "verse" &&
            o.target.book === book &&
            o.target.chapter === chapter &&
            o.target.verse === verse &&
            o.target.bibleVersion === bv,
        )
        .map((o) => o.status);
    },
    { book: BOOK, chapter: r.chapter, verse: r.verse, bv: BV },
  );
}

// Move the verse on the server (append a plain text node, leaving every
// alignment milestone alone), then wait until this tab's chapter cache holds
// the new version, so the reading line's `verse` prop is the moved verse.
async function bumpVerse(page: Page, request: APIRequestContext, csrf: string, tag: string): Promise<number> {
  const cur = await serverVerse(request);
  const content = JSON.parse(cur.content_json) as { verseObjects: unknown[] };
  content.verseObjects.push({ type: "text", text: ` ${tag}` });
  const version = await putVerse(request, csrf, content, `${cur.plain_text} ${tag}`);
  await expect.poll(() => cachedVersion(page)).toBe(version);
  return version;
}

type Opened = { dialog: Locator; line: Locator; save: Locator; undo: Locator; title: Locator };

async function openDual(page: Page, r: Ref = V72): Promise<Opened> {
  await page.goto(`/#/${BOOK}/${r.chapter}/${r.verse}`);
  await page.reload();
  await page
    .locator(`[data-find-cell="${r.chapter}-${r.verse}-${BV}"]`)
    .first()
    .waitFor({ timeout: 15_000 });
  await page.locator(`button[aria-label^="align ${BV}"]`).first().click();
  const sideBySide = page.locator("button", { hasText: "Side-by-side" }).first();
  await sideBySide.waitFor({ state: "visible" });
  await sideBySide.click();
  const dialog = page.getByRole("dialog").filter({ hasText: "reading text" });
  const editable = dialog.locator('[contenteditable="true"]:visible');
  await editable.first().waitFor({ state: "visible" });
  // Left = ULT. Tag it so it stays addressable.
  await editable.first().evaluate((el) => el.setAttribute("data-s19-line", "ULT"));
  const line = dialog.locator('[data-s19-line="ULT"]');
  const lineBox = line.locator("..");
  return {
    dialog,
    line,
    save: lineBox.getByRole("button", { name: `Save ${BV}`, exact: true }),
    undo: lineBox.getByRole("button", { name: "Undo", exact: true }),
    // Somewhere to click that takes focus off the line without editing anything.
    title: lineBox.getByText(`${BV} · reading text`),
  };
}

// Type at the end of the line with the real keyboard, so the line keeps focus.
async function typeAtEnd(page: Page, line: Locator, text: string) {
  await line.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(text);
}

function nextVersePatch(page: Page, r: Ref = V72) {
  return page.waitForResponse(
    (res) => res.request().method() === "PATCH" && res.url().includes(versePath(r)),
    { timeout: 15_000 },
  );
}

// Whether the word `text` sits inside an alignment milestone in a verse tree.
function wordIsAligned(content: unknown, text: string): boolean {
  const walk = (nodes: unknown[], inZaln: boolean): boolean | undefined => {
    for (const n of nodes as { tag?: string; text?: string; children?: unknown[] }[]) {
      if (n.tag === "w" && n.text === text) return inZaln;
      if (n.children) {
        const found = walk(n.children, inZaln || n.tag === "zaln");
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  const found = walk((content as { verseObjects: unknown[] }).verseObjects, false);
  expect(found, `word "${text}" not in the verse`).not.toBeUndefined();
  return found === true;
}

test("a reading-line edit pins its base on the first keystroke: a server change that lands while the line is focused makes Save a 409, not an overwrite", async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const { context } = await newUserContext(browser, "deferredreward");
  const csrf = await csrfToken(context.request);
  const page = await context.newPage();
  const original = await serverVerse(context.request);
  const stamp = Date.now();
  const tag = `[s19-${stamp}]`;

  try {
    const o = await openDual(page);
    expect(await pinnedVersion(page)).toBeUndefined();

    await typeAtEnd(page, o.line, ` EDIT-${stamp}`);
    await expect(o.save).toBeEnabled();
    // Pinned on the first keystroke, to the version the box shows.
    expect(await pinnedVersion(page)).toBe(original.version);

    // Another editor changes the verse while the translator is still in the
    // box: the focused line is not resynced, so it still shows the old text.
    const bumped = await bumpVerse(page, context.request, csrf, tag);
    expect(bumped).toBeGreaterThan(original.version);
    await expect(o.line).not.toContainText(tag);
    await expect(o.line).toContainText(`EDIT-${stamp}`);

    // Save sends the version the edit was made against, and the server refuses.
    const patched = nextVersePatch(page);
    await o.save.click();
    const res = await patched;
    expect(res.request().headers()["if-match"]).toBe(String(original.version));
    expect(res.status()).toBe(409);
    // Settled: the op is parked as a conflict (merge prompt), not retried.
    await expect.poll(() => verseOpStatuses(page)).toEqual(["conflict"]);
    const after = (await serverVerse(context.request)).plain_text;
    expect(after).toContain(tag);
    expect(after).not.toContain(`EDIT-${stamp}`);
  } finally {
    await putVerse(context.request, csrf, JSON.parse(original.content_json), original.plain_text);
    await context.close();
  }
});

test("a reading-line pin is released however the line goes clean (Undo, typed back, unfocused resync): a new edit after the verse moved saves with a 200", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const { context } = await newUserContext(browser, "deferredreward");
  const csrf = await csrfToken(context.request);
  const page = await context.newPage();
  const original = await serverVerse(context.request);
  const stamp = Date.now();

  // After the line went clean: the verse moves (the line is unfocused, so it
  // shows the move), then a new edit is saved against the moved version.
  const saveAfterMove = async (o: Opened, n: number) => {
    await expect.poll(() => pinnedVersion(page)).toBeUndefined();
    await o.title.click();
    const moved = await bumpVerse(page, context.request, csrf, `[s19-${n}-${stamp}]`);
    await expect(o.line).toContainText(`[s19-${n}-${stamp}]`);
    await typeAtEnd(page, o.line, ` AFTER${n}-${stamp}`);
    expect(await pinnedVersion(page)).toBe(moved);
    const patched = nextVersePatch(page);
    await o.save.click();
    const res = await patched;
    expect(res.request().headers()["if-match"]).toBe(String(moved));
    expect(res.status()).toBe(200);
    await expect(o.undo).toBeDisabled();
    await expect
      .poll(async () => (await serverVerse(context.request)).plain_text)
      .toContain(`AFTER${n}-${stamp}`);
    // The landed save's outbox exit releases the pin.
    await expect.poll(() => pinnedVersion(page)).toBeUndefined();
  };

  try {
    const o = await openDual(page);

    // 1. Undo.
    await typeAtEnd(page, o.line, ` UNDO-${stamp}`);
    expect(await pinnedVersion(page)).toBeDefined();
    await o.undo.click();
    await expect(o.undo).toBeDisabled();
    await saveAfterMove(o, 1);

    // 2. Typed back by hand (no Undo).
    await typeAtEnd(page, o.line, "QQ");
    expect(await pinnedVersion(page)).toBeDefined();
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await expect(o.undo).toBeDisabled();
    await saveAfterMove(o, 2);

    // 3. The verse moves onto the line's own text while the line is not
    //    focused: the resync finds nothing left unsaved. (A verse change never
    //    replaces a dirty line's text (#1067), so this is the only way a
    //    resync cleans one.)
    await typeAtEnd(page, o.line, ` RESYNC-${stamp}`);
    expect(await pinnedVersion(page)).toBeDefined();
    await o.title.click();
    await bumpVerse(page, context.request, csrf, `RESYNC-${stamp}`);
    await expect(o.undo).toBeDisabled();
    await saveAfterMove(o, 3);
  } finally {
    await putVerse(context.request, csrf, JSON.parse(original.content_json), original.plain_text);
    await context.close();
  }
});

// #1067: the unfocused resync used to replace a dirty line's text whenever
// the verse changed, since its "still showing what we set?" check compared
// against text onInput keeps equal to the box. The edit vanished, the line
// went clean and its pin was released, with nothing to warn the translator.
test("a reading line with unsaved text that lost focus keeps it when another editor changes the verse: Save is a 409 and a merge prompt", async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const { context } = await newUserContext(browser, "deferredreward");
  const csrf = await csrfToken(context.request);
  const page = await context.newPage();
  const original = await serverVerse(context.request);
  const stamp = Date.now();
  const tag = `[s19-unfocused-${stamp}]`;

  try {
    const o = await openDual(page);
    await typeAtEnd(page, o.line, ` EDIT-${stamp}`);
    expect(await pinnedVersion(page)).toBe(original.version);

    // Click into the alignment panel: the line loses focus, still dirty.
    await o.dialog.getByText(`${BV} words`, { exact: true }).first().click();
    await expect(o.line).not.toBeFocused();
    await expect(o.save).toBeEnabled();

    const bumped = await bumpVerse(page, context.request, csrf, tag);
    expect(bumped).toBeGreaterThan(original.version);
    // The moved verse has rendered (the main column behind the dialog shows
    // it), so the line's resync has run by now.
    await expect(page.locator(`[data-find-cell="${V72.chapter}-${V72.verse}-${BV}"]`).first()).toContainText(tag);

    // The edit is still on screen, still unsaved, still pinned to its base.
    await expect(o.line).toContainText(`EDIT-${stamp}`);
    await expect(o.line).not.toContainText(tag);
    await expect(o.save).toBeEnabled();
    expect(await pinnedVersion(page)).toBe(original.version);

    const patched = nextVersePatch(page);
    await o.save.click();
    const res = await patched;
    expect(res.request().headers()["if-match"]).toBe(String(original.version));
    expect(res.status()).toBe(409);
    await expect.poll(() => verseOpStatuses(page)).toEqual(["conflict"]);
    await expect(page.getByText("resolve 1 conflict")).toBeVisible();
    const after = (await serverVerse(context.request)).plain_text;
    expect(after).toContain(tag);
    expect(after).not.toContain(`EDIT-${stamp}`);
  } finally {
    await putVerse(context.request, csrf, JSON.parse(original.content_json), original.plain_text);
    await context.close();
  }
});

// #1067 review: the line is not tied to one row. A bridge (or split) by
// another editor maps the slot onto a different row; an edit kept across that
// would be saved onto the new row with that row's fresh version (200), and the
// v7-only text would replace the whole 6-7 row, deleting verse 6. A change of
// row drops the line's edit and its pin instead.
test("a dirty reading line whose verse is bridged into another row by another editor never saves its text onto the bridged row", async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const { context } = await newUserContext(browser, "deferredreward");
  const csrf = await csrfToken(context.request);
  const page = await context.newPage();
  const UST = "UST";
  const V6 = `/api/verses/${BOOK}/7/6/${UST}`;
  const V7 = `/api/verses/${BOOK}/7/7/${UST}`;
  const get = async (path: string) => {
    const res = await context.request.get(path);
    expect(res.ok()).toBe(true);
    return (await res.json()) as VerseRow & { verse_end: number | null };
  };
  const orig6 = await get(V6);
  const orig7 = await get(V7);
  expect(orig6.verse_end).toBeNull();
  const stamp = Date.now();
  const key = (v: number) => `verse:${BOOK}:7:${v}:${UST}`;
  const peek = (k: string) =>
    page.evaluate((kk) => (window as unknown as PinDebugWindow).__bePinDebug?.peek(kk)?.version, k);
  const current = (k: string) =>
    page.evaluate((kk) => (window as unknown as PinDebugWindow).__bePinDebug?.currentVersion(kk), k);
  let bridged = false;

  try {
    const o = await openDual(page, { chapter: 7, verse: 7 });
    const lineBox = o.dialog
      .locator("div:has(> [contenteditable])")
      .filter({ hasText: `${UST} · reading text` });
    const line = lineBox.locator("[contenteditable]");
    const save = lineBox.getByRole("button", { name: `Save ${UST}`, exact: true });
    await expect(line).toContainText("former prophets");

    await typeAtEnd(page, line, ` EDIT-${stamp}`);
    expect(await peek(key(7))).toBe(orig7.version);
    // Off the line, still dirty.
    await o.dialog.getByText(`${UST} words`, { exact: true }).first().click();
    await expect(line).not.toBeFocused();
    await expect(save).toBeEnabled();

    // Another editor bridges 6+7 into one row.
    const res = await context.request.post(`${V6}/bridge`, {
      headers: { "x-csrf-token": csrf },
      data: { start_version: orig6.version, next_version: orig7.version },
    });
    expect(res.status(), await res.text()).toBe(200);
    bridged = true;
    const bridgedVersion = ((await res.json()) as { verse: { version: number } }).verse.version;
    await expect.poll(() => current(key(6))).toBe(bridgedVersion);

    // Whatever the line shows now, a Save (if it offers one) must not put the
    // v7-only text over the bridged row.
    if (await save.isEnabled()) {
      // Dropping verse 6's aligned words asks first; answer it if it comes.
      const confirm = page.getByRole("dialog").filter({ hasText: "will be unaligned" });
      let sent = false;
      const patched = page
        .waitForResponse((r) => r.request().method() === "PATCH" && r.url().includes(V6), { timeout: 15_000 })
        .then((r) => {
          sent = true;
          return r;
        });
      await save.click();
      await expect.poll(async () => sent || (await confirm.isVisible()), { timeout: 10_000 }).toBe(true);
      if (!sent) await confirm.getByRole("button", { name: "Save anyway" }).click();
      await patched;
    }
    const after6 = await get(V6);
    expect(after6.verse_end).toBe(7);
    expect(after6.plain_text).toContain("feasted");
    expect(after6.plain_text).not.toContain(`EDIT-${stamp}`);

    // The line shows the bridged row, clean, and the v7 pin is gone.
    await expect(line).toContainText("feasted");
    await expect(line).not.toContainText(`EDIT-${stamp}`);
    await expect(save).toBeDisabled();
    await expect.poll(() => peek(key(7))).toBeUndefined();
  } finally {
    if (bridged) {
      const cur = await get(V6);
      const split = await context.request.post(`${V6}/split`, {
        headers: { "x-csrf-token": csrf, "If-Match": String(cur.version) },
      });
      expect(split.status(), await split.text()).toBe(200);
    }
    for (const [path, orig] of [
      [V6, orig6],
      [V7, orig7],
    ] as const) {
      const cur = await get(path);
      const put = await context.request.patch(path, {
        headers: { "x-csrf-token": csrf, "If-Match": String(cur.version) },
        data: { content: JSON.parse(orig.content_json), plain_text: orig.plain_text },
      });
      expect(put.status(), await put.text()).toBe(200);
    }
    await context.close();
  }
});

// Review round 1: this tab's own writes must not 409 the translator. The hold
// detects OTHER editors' changes; a save of this tab's that lands while the
// line is dirty moves the held base forward instead.

test("typing in the reading line, then saving an alignment change in the panel, then saving the line: 200, and both survive", async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const { context } = await newUserContext(browser, "deferredreward");
  const csrf = await csrfToken(context.request);
  const page = await context.newPage();
  const original = await serverVerse(context.request, V62);
  const stamp = Date.now();
  expect(wordIsAligned(JSON.parse(original.content_json), "horses")).toBe(true);

  try {
    const o = await openDual(page, V62);
    await typeAtEnd(page, o.line, ` TXT-${stamp}`);
    expect(await pinnedVersion(page, V62)).toBe(original.version);

    // Unalign "horses" in the ULT panel and save it. While the panel has
    // unsaved drags the line is locked ("save alignment first"), so its own
    // Save button is hidden and the panel's is the only "Save ULT".
    const chip = o.dialog.locator('[draggable="true"]').filter({ hasText: "horses" }).first();
    await chip.dragTo(o.dialog.getByText(`${BV} words`, { exact: true }).first());
    await expect(o.dialog.getByText("🔒 save alignment first")).toBeVisible();
    // The "will be unaligned" confirm shows on a fresh seed, but not once s17
    // has already edited this verse in the same run. The confirm gates the
    // PATCH, so exactly one of the two comes first: answer the confirm only if
    // it is up and nothing has been sent yet.
    let alignSent = false;
    const alignPatch = nextVersePatch(page, V62).then((r) => {
      alignSent = true;
      return r;
    });
    const unalignConfirm = page.getByRole("dialog").filter({ hasText: "will be unaligned" });
    await o.dialog.getByRole("button", { name: `Save ${BV}`, exact: true }).click();
    await expect
      .poll(async () => alignSent || (await unalignConfirm.isVisible()), { timeout: 10_000 })
      .toBe(true);
    if (!alignSent) await unalignConfirm.getByRole("button", { name: "Save anyway" }).click();
    const aligned = await alignPatch;
    expect(aligned.status()).toBe(200);
    const alignedVersion = ((await aligned.json()) as { version: number }).version;

    // The line is still dirty, and its base moved with this tab's own save.
    await expect(o.save).toBeEnabled();
    await expect(o.line).toContainText(`TXT-${stamp}`);
    await expect.poll(() => pinnedVersion(page, V62)).toBe(alignedVersion);

    const textPatch = nextVersePatch(page, V62);
    await o.save.click();
    const res = await textPatch;
    // The text save unaligns nothing, so it never asks.
    await expect(unalignConfirm).toHaveCount(0);
    expect(res.request().headers()["if-match"]).toBe(String(alignedVersion));
    expect(res.status()).toBe(200);
    const after = await serverVerse(context.request, V62);
    expect(after.plain_text).toContain(`TXT-${stamp}`);
    expect(wordIsAligned(JSON.parse(after.content_json), "horses")).toBe(false);
  } finally {
    await putVerse(context.request, csrf, JSON.parse(original.content_json), original.plain_text, V62);
    await context.close();
  }
});

test("save, keep typing while that save is in flight, save again after it lands: 200, both edits survive", async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const { context } = await newUserContext(browser, "deferredreward");
  const csrf = await csrfToken(context.request);
  const page = await context.newPage();
  const original = await serverVerse(context.request);
  const stamp = Date.now();

  try {
    const o = await openDual(page);

    // Hold the first save's PATCH on the wire until the second edit is typed.
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((r) => (releaseFirst = r));
    const pattern = `**${versePath(V72)}`;
    await page.route(pattern, async (route) => {
      if (route.request().method() === "PATCH") await firstHeld;
      await route.continue();
    });

    await typeAtEnd(page, o.line, ` FIRST-${stamp}`);
    const first = nextVersePatch(page);
    await o.save.click();
    await expect(o.undo).toBeDisabled();
    await typeAtEnd(page, o.line, ` SECOND-${stamp}`);
    await expect(o.save).toBeEnabled();

    releaseFirst();
    const firstRes = await first;
    expect(firstRes.status()).toBe(200);
    const landed = ((await firstRes.json()) as { version: number }).version;
    await page.unroute(pattern);
    await expect.poll(() => pinnedVersion(page)).toBe(landed);

    const second = nextVersePatch(page);
    await o.save.click();
    const res = await second;
    expect(res.request().headers()["if-match"]).toBe(String(landed));
    expect(res.status()).toBe(200);
    const after = (await serverVerse(context.request)).plain_text;
    expect(after).toContain(`FIRST-${stamp}`);
    expect(after).toContain(`SECOND-${stamp}`);
  } finally {
    await putVerse(context.request, csrf, JSON.parse(original.content_json), original.plain_text);
    await context.close();
  }
});

// Review round 2: a Save that turns out to be a no-op (the text is back to the
// base the edit was held against) queues nothing, so it must end the hold as a
// clean line does and release the pin, even after another editor moved the
// verse under the focused line.
test("a no-op Save after another editor moved the verse queues nothing and leaks no pin", async ({ browser }) => {
  test.setTimeout(60_000);
  const { context } = await newUserContext(browser, "deferredreward");
  const csrf = await csrfToken(context.request);
  const page = await context.newPage();
  const original = await serverVerse(context.request);
  const stamp = Date.now();
  const typed = ` X${stamp}`;

  try {
    const o = await openDual(page);
    const writes: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "PATCH" && req.url().includes(versePath(V72))) writes.push(req.url());
    });

    await typeAtEnd(page, o.line, typed);
    expect(await pinnedVersion(page)).toBe(original.version);
    await bumpVerse(page, context.request, csrf, `[s19-noop-${stamp}]`);
    // Erase the edit by hand: the box shows the held base's text again, which
    // still differs from the moved verse, so the line stays dirty.
    for (let i = 0; i < typed.length; i++) await page.keyboard.press("Backspace");
    await expect(o.line).not.toContainText(`X${stamp}`);
    await expect(o.save).toBeEnabled();

    await o.save.click();
    await expect(o.undo).toBeDisabled();
    await expect.poll(() => pinnedVersion(page)).toBeUndefined();
    expect(writes).toEqual([]);
    // Clean now, so it shows the server's text, not the stale base (#1067 review).
    await expect(o.line).toContainText(`[s19-noop-${stamp}]`);
  } finally {
    await putVerse(context.request, csrf, JSON.parse(original.content_json), original.plain_text);
    await context.close();
  }
});
