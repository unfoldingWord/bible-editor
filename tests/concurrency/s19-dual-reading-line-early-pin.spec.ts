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
//      replaced by an unfocused resync): a new edit saved after the verse
//      moved again lands with a 200, never a 409 from a leaked pin.
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

    // 3. Replaced by a resync from the server while the line is not focused.
    await typeAtEnd(page, o.line, ` RESYNC-${stamp}`);
    expect(await pinnedVersion(page)).toBeDefined();
    await o.title.click();
    await bumpVerse(page, context.request, csrf, `[s19-3a-${stamp}]`);
    await expect(o.line).toContainText(`[s19-3a-${stamp}]`);
    await expect(o.line).not.toContainText(`RESYNC-${stamp}`);
    await expect(o.undo).toBeDisabled();
    await saveAfterMove(o, 3);
  } finally {
    await putVerse(context.request, csrf, JSON.parse(original.content_json), original.plain_text);
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
    const alignPatch = nextVersePatch(page, V62);
    await o.dialog.getByRole("button", { name: `Save ${BV}`, exact: true }).click();
    // The "will be unaligned" confirm shows on a fresh seed, but not once s17
    // has already edited this verse in the same run, so answer it only if it
    // comes up.
    const saveAnyway = page
      .getByRole("dialog")
      .filter({ hasText: "will be unaligned" })
      .getByRole("button", { name: "Save anyway" });
    await Promise.race([
      alignPatch,
      saveAnyway.waitFor({ timeout: 10_000 }).then(() => saveAnyway.click()).catch(() => undefined),
    ]);
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
