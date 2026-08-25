import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, request as apiRequest, type Page, type Locator } from "@playwright/test";
import { fetchChapter, mintToken, newUserContext, noteTextarea, saveNote } from "./helpers";

// Honor BE_BASE_URL so the suite runs on a relocated port (mirrors s7/s8).
const BASE = process.env.BE_BASE_URL ?? "http://localhost:5173";

// S9 — issue #571: end-to-end coverage of the #565/#569 verse-baseline-pin
// release rule (`web/src/sync/versePin.ts` + the terminal-exit wiring in
// `web/src/sync/drafts.ts`), through the REAL BroadcastChannel / IndexedDB /
// cross-tab-exclusive-drain plumbing — not the pure functions PR #569's unit
// tests already cover in `web/src/sync/draftSaveState.test.mjs`. Read that
// file's comments alongside this one; the two success checks below are its
// "unit-shaped" cross-tab-ok and locked-exit scenarios driven through the
// real browser instead.
//
// Both checks use the dual-aligner's reading line (`SideBySideAligner.tsx`'s
// `ReadingLine`) as the DRAFTLESS save path: unlike every other verse edit
// surface, it never calls `drafts.set()` on keystroke (see its "no autosave"
// header comment), so a landed/dropped save has no draft record for the
// release rule to key off — the pin is the ONLY thing tracking that edit
// session, which is exactly the leak #565 found.

const apiDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../api");

// Seed / clear a chapter-locking pipeline_jobs row directly in the LOCAL D1
// SQLite file `wrangler dev` already has open (same mechanism global-setup.ts
// uses to seed ZEC). This never touches DCS or a remote database — see
// CLAUDE.md's dev/prod D1 split; `bible_editor_dev` is the local-only target.
//
// Deliberately NOT shell:true (global-setup.ts's pattern, needed there for
// Windows' npx→npx.cmd resolution): with a `--command` value that contains
// spaces, shell:true's argv-join-without-quoting on POSIX re-splits the SQL
// on whitespace and wrangler sees garbage. Naming the platform's real npx
// executable gets the same Windows .cmd resolution without a shell in the
// middle to mangle quoting.
function d1(sql: string): void {
  const res = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["wrangler", "d1", "execute", "bible_editor_dev", "--local", "--command", sql],
    { cwd: apiDir, stdio: "pipe" },
  );
  if (res.status !== 0) {
    throw new Error(
      `wrangler d1 execute failed (status ${res.status}): ${res.stderr?.toString() ?? ""}`,
    );
  }
}

interface OutboxOpSnapshot {
  status: string;
  lastError?: string;
  expectedVersion: number;
  target: {
    kind: string;
    book?: string;
    chapter?: number;
    verse?: number;
    bibleVersion?: string;
  };
}

// Same IndexedDB shape s7-offline-resilience.spec.ts reads directly — the
// store schema matches outbox.ts: DB "bible-editor-outbox", store "ops".
async function readOutboxOps(page: Page): Promise<OutboxOpSnapshot[]> {
  return page.evaluate(async () => {
    const open = (name: string, version: number) =>
      new Promise<IDBDatabase>((res, rej) => {
        const req = indexedDB.open(name, version);
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      });
    const db = await open("bible-editor-outbox", 1);
    const ops = await new Promise<unknown[]>((res, rej) => {
      const tx = db.transaction("ops", "readonly");
      const req = tx.objectStore("ops").getAll();
      req.onsuccess = () => res(req.result as unknown[]);
      req.onerror = () => rej(req.error);
    });
    db.close();
    return ops;
  }) as Promise<OutboxOpSnapshot[]>;
}

function findVerseOp(
  ops: OutboxOpSnapshot[],
  book: string,
  chapter: number,
  verse: number,
  bibleVersion: string,
): OutboxOpSnapshot | undefined {
  return ops.find(
    (o) =>
      o.target.kind === "verse" &&
      o.target.book === book &&
      o.target.chapter === chapter &&
      o.target.verse === verse &&
      o.target.bibleVersion === bibleVersion,
  );
}

// Open the dual (side-by-side ULT/UST) aligner on the active verse: click the
// per-version "align" link icon (opens the single AlignmentPanel), then its
// "⇄ Side-by-side" action (opens SideBySideAligner as a Dialog). Returns the
// bibleVersion's own reading-line contentEditable div — left=ULT, right=UST,
// a stable DOM order per SideBySideAligner.tsx's own left/right render order.
async function openDualAlignerReadingLine(page: Page, bibleVersion: "ULT" | "UST"): Promise<Locator> {
  await page.locator(`button[aria-label^="align ${bibleVersion}"]`).first().click();
  const sideBySideBtn = page.locator("button", { hasText: "Side-by-side" }).first();
  await sideBySideBtn.waitFor({ state: "visible" });
  await sideBySideBtn.click();
  const idx = bibleVersion === "ULT" ? 0 : 1;
  const line = page.locator('.MuiDialog-root [contenteditable="true"]:visible').nth(idx);
  await line.waitFor({ state: "visible" });
  return line;
}

// Append `text` to the reading line's current content and click its explicit
// Save button (the reading line never autosaves — see ReadingLine's header
// comment). A pure end-of-verse insertion never trips the collateral-
// alignment-loss confirm, so this always enqueues synchronously.
async function appendAndSaveReadingLine(
  page: Page,
  line: Locator,
  bibleVersion: string,
  text: string,
): Promise<void> {
  await line.click();
  await page.keyboard.press("End");
  await page.keyboard.type(text);
  await page
    .locator(".MuiDialog-root button:visible", { hasText: `Save ${bibleVersion}` })
    .first()
    .click();
}

// The SyncStatusBar chip that appears the moment any op reaches "conflict"
// status (`${n} conflict(s)`, resolved by the user) — the exact UI surface
// success check (a) must never trigger. See SyncStatusBar.tsx's `conflicts`
// chip.
function conflictChip(page: Page): Locator {
  return page.getByText(/\d+ conflicts?/);
}

test.describe("S9 — cross-tab verse pin release (#565 / #569 / #571)", () => {
  // ── Success check (a) ────────────────────────────────────────────────────
  // Tab A performs a draftless dual-aligner reading-line save. Tab B is the
  // one that actually drains it — the outbox drain is cross-tab-exclusive
  // (navigator.locks: "be-outbox-drain") while the verse-base pin
  // (versePin.ts) is per-tab in-memory state, so tab B draining tab A's op
  // and reporting "ok" locally does nothing for tab A's own pin. Before
  // #569, nothing told tab A its save had landed; its pin (the diff baseline
  // + expected_version from BEFORE the save) leaked for the rest of the tab's
  // life. A follow-up save on the SAME verse in tab A then diffs against that
  // stale baseline and sends the stale (now-superseded) expected_version —
  // guaranteed 409 version_mismatch, surfaced to the user as a merge-conflict
  // prompt neither edit did anything to deserve.
  //
  // #569 fixes this by broadcasting every verse op's terminal exit over a
  // BroadcastChannel; every tab (including the one that never drained
  // anything) runs the same release rule against its own pin. This test
  // forces tab B to hold the drain lock across the moment tab A enqueues, by
  // gating a DECOY row save's PATCH behind a manually-released promise: tab B
  // acquires "be-outbox-drain" to send it, so tab A's own drain() attempt
  // (fired synchronously by its enqueue) is guaranteed to lose the
  // ifAvailable race and leave its op for tab B to pick up later in the SAME
  // held pass.
  //
  // Per the issue's own guidance we assert on the OBSERVABLE OUTCOME — no
  // conflict chip, the follow-up save actually drains and lands the right
  // text — rather than on pin internals (the pin map is deliberately
  // unexposed). Unlike check (b) below, this scenario has a genuine
  // observable difference: tab B's drained save bumps the server's version,
  // so a leaked pin's stale expected_version is guaranteed to 409.
  test("tab A's draftless save, drained by tab B, releases tab A's pin — a follow-up save lands clean", async ({
    browser,
  }) => {
    const CHAPTER = 1;
    const VERSE = 1;
    const BV = "ULT";

    const probe = await apiRequest.newContext({ baseURL: BASE });
    const probeAuth = await mintToken(probe, "probe-s9a");
    const chapter = await fetchChapter(probe, probeAuth.token, "ZEC", CHAPTER);
    const decoyRow = chapter.tn.find((r) => r.verse === VERSE);
    expect(decoyRow, `expected a TN row on ZEC ${CHAPTER}:${VERSE} to use as the decoy save`).toBeTruthy();
    await probe.dispose();

    // ONE browser context (one signed-in profile), TWO pages — real multi-tab
    // semantics. IndexedDB, localStorage, BroadcastChannel and
    // navigator.locks are all origin-scoped to the browser profile, not the
    // page, so two SEPARATE newUserContext() calls (as S1/S2/S6 use for two
    // DIFFERENT users) would give each its own isolated storage and could
    // never reproduce this cross-tab leak.
    const { context } = await newUserContext(browser, "pinrelease-a");
    const tabA = await context.newPage();
    const tabB = await context.newPage();

    // Gate every decoy-row PATCH behind a promise this test resolves on cue,
    // so tab B is provably still holding "be-outbox-drain" (mid-dispatch)
    // at the instant tab A enqueues its own save.
    let releaseGate: () => void;
    const gate = new Promise<void>((res) => {
      releaseGate = res;
    });
    await context.route(`**/api/rows/tn/${decoyRow!.id}**`, async (route, request) => {
      if (request.method() === "PATCH") await gate;
      await route.continue();
    });

    await tabB.goto(`${BASE}/#/ZEC/${CHAPTER}/${VERSE}`);
    await tabB.locator("[data-note-id]").first().waitFor();
    await noteTextarea(tabB, decoyRow!.id).fill(`decoy ${Date.now()}`);
    await saveNote(tabB, decoyRow!.id);

    // Tab B must actually be mid-dispatch (holding the lock) before tab A
    // acts, or the race this test exists to force never happens.
    await expect
      .poll(async () => {
        const ops = await readOutboxOps(tabB);
        return ops.some((o) => o.target.kind === "row" && o.status === "in_flight");
      }, { message: "decoy op never reached in_flight — tab B should be holding the drain lock" })
      .toBe(true);

    await tabA.goto(`${BASE}/#/ZEC/${CHAPTER}/${VERSE}`);
    await tabA.locator("[data-note-id]").first().waitFor();
    const lineA = await openDualAlignerReadingLine(tabA, BV);
    const mark1 = ` PINA1-${Date.now()}`;
    await appendAndSaveReadingLine(tabA, lineA, BV, mark1);

    // While tab B still holds the lock, tab A's own drain() attempt must
    // have lost the ifAvailable race — its op is enqueued but NOT drained
    // locally. A short bounded wait is deterministic here (not a race): the
    // gate is still closed, so nothing can drain this op out from under us
    // regardless of how long we wait.
    await tabA.waitForTimeout(400);
    const midOps = await readOutboxOps(tabA);
    const midOp = findVerseOp(midOps, "ZEC", CHAPTER, VERSE, BV);
    expect(midOp?.status, "tab A must not have drained its own save while tab B holds the lock").toBe("pending");

    // Release tab B's decoy PATCH. Its drainPass loop re-reads the shared
    // IndexedDB store before giving up the lock, so it picks up tab A's now-
    // pending op and drains THAT too, in the same held pass — tab B is the
    // tab that actually sends tab A's PATCH.
    releaseGate!();

    await expect
      .poll(async () => !findVerseOp(await readOutboxOps(tabB), "ZEC", CHAPTER, VERSE, BV), {
        message: "tab A's verse op was never drained by tab B",
        timeout: 15_000,
      })
      .toBe(true);

    const serverCtx = await apiRequest.newContext({ baseURL: BASE });
    const serverAuth = await mintToken(serverCtx, "verifier-s9a");
    const afterFirst = await fetchChapter(serverCtx, serverAuth.token, "ZEC", CHAPTER);
    // @ts-expect-error — ChapterPayload's type doesn't declare `verses`, but
    // the API always returns it (see api/src/chapters.ts); helpers.ts's type
    // is scoped to what the TN-focused specs need.
    const ultAfterFirst = afterFirst.verses[BV][VERSE];
    expect(ultAfterFirst.plain_text as string).toContain(mark1.trim());

    // Same key format drafts.ts's verseKey() produces — used both by the
    // version poll right below and by the steady-state pin check at the end.
    const key = `verse:ZEC:${CHAPTER}:${VERSE}:${BV}`;

    // Wait for tab A to have actually LEARNED the post-tab-B-save version —
    // not a fixed guess at how long that takes. Two things must both catch
    // up before a follow-up save on tab A can land clean:
    //   (1) the BroadcastChannel pin-release (~ms, same-process postMessage)
    //   (2) tab A's chapter cache observing the new version over the
    //       WebSocket fanout (`Shell.tsx`'s onVerseUpdate) — this is the
    //       ONLY route tab A has to the post-save version, since tab B (not
    //       tab A) did the draining, and it's unbounded: the server sends it
    //       via `c.executionCtx.waitUntil(broadcastChapter(...))` AFTER the
    //       200 (api/src/verses.ts), fire-and-forget. A fixed 400ms wait
    //       here raced #605: on a slow run the WS frame can still be in
    //       flight when the follow-up save fires, so it diffs/sends against
    //       the STALE version and 409s — misreported by the poll below as
    //       "the #565 leak" when it's actually just a late WS frame.
    // Polling the actual observable state (rather than a longer guess) makes
    // this deterministic on a fast run and robust on a slow one. See #605 and
    // drafts.ts's `window.__bePinDebug.currentVersion` (DEV-only) for the hook.
    await expect
      .poll(
        () =>
          tabA.evaluate(
            (k) =>
              (
                window as unknown as {
                  __bePinDebug?: { currentVersion: (key: string) => number | undefined };
                }
              ).__bePinDebug?.currentVersion(k),
            key,
          ),
        {
          message: "tab A never observed tab B's save (WS fanout) — the follow-up save would race a stale version",
          timeout: 15_000,
        },
      )
      .toBe(ultAfterFirst.version as number);

    // The follow-up: a SECOND draftless save on the SAME verse, same tab,
    // same still-open dialog. Without #569 this diffs against the pin tab A
    // set for the FIRST save (stale content, expected_version from before
    // tab B's PATCH landed) and 409s. With it, the first save's exit
    // released that pin, so this save re-pins the fresh post-tab-B base and
    // lands clean.
    const mark2 = ` PINA2-${Date.now()}`;
    await appendAndSaveReadingLine(tabA, lineA, BV, mark2);

    await expect
      .poll(async () => !findVerseOp(await readOutboxOps(tabA), "ZEC", CHAPTER, VERSE, BV), {
        message: "the follow-up save never drained — it is stuck (conflict/failed), which is the #565 leak",
        timeout: 15_000,
      })
      .toBe(true);

    // Never a conflict prompt at any point during that follow-up save.
    await expect(conflictChip(tabA)).toHaveCount(0);

    const afterSecond = await fetchChapter(serverCtx, serverAuth.token, "ZEC", CHAPTER);
    // @ts-expect-error — see the same note above.
    const ultAfterSecond = afterSecond.verses[BV][VERSE];
    // Both edits landed, IN ORDER, on top of each other — not just "a" save
    // succeeded, but the follow-up correctly built on the first save's text
    // rather than re-diffing from stale pre-first-save content.
    const text = ultAfterSecond.plain_text as string;
    expect(text.indexOf(mark1.trim())).toBeGreaterThanOrEqual(0);
    expect(text.indexOf(mark2.trim())).toBeGreaterThan(text.indexOf(mark1.trim()));
    expect(ultAfterSecond.version as number).toBe((ultAfterFirst.version as number) + 1);

    // Steady state: no pin left dangling in tab A once both saves have
    // landed (bonus cross-check via the DEV-only hook — see drafts.ts).
    const finalPin = await tabA.evaluate(
      (k) => (window as unknown as { __bePinDebug?: { peek: (k: string) => unknown } }).__bePinDebug?.peek(k),
      key,
    );
    expect(finalPin).toBeUndefined();

    await serverCtx.dispose();
    await context.close();
  });

  // ── Success check (b) ────────────────────────────────────────────────────
  // A draftless reading-line save against a chapter an AI pipeline currently
  // owns: the server rejects the PATCH with 409 chapter_locked
  // (api/src/chapterLock.ts), the outbox deletes the op permanently (no
  // retry — the pending auto-apply will overwrite it anyway) and Shell
  // surfaces the "Edit dropped" toast. No 200 EVER follows a locked exit, so
  // — same as a discard — the draftless pin can only be released right here;
  // before #569 nothing did.
  //
  // Unlike check (a), this scenario has NO externally observable outcome
  // difference: the server's version never moves while the chapter stays
  // locked (the PATCH is rejected, not merely delayed), so a LEAKED pin and
  // a freshly-released one both carry the SAME expected_version at the next
  // save and produce the SAME "lands clean" result either way — confirmed by
  // hand against this exact scenario with the #569 listener wiring
  // temporarily disabled (see the issue's own manual-revert instruction).
  // The issue anticipates exactly this: "if that proves too indirect, add a
  // dev-only introspection hook" — `window.__bePinDebug.peek()` (drafts.ts,
  // gated on import.meta.env.DEV) is that hook, and it is what actually
  // distinguishes leaked from released here.
  test("a locked-chapter save is dropped with the lock toast and releases its pin; a save after the lock clears lands clean", async ({
    browser,
  }) => {
    const CHAPTER = 3;
    const VERSE = 1;
    const BV = "ULT";
    const JOB_ID = "s9-verse-pin-release-lock";

    const { context, auth } = await newUserContext(browser, "pinrelease-b");
    const page = await context.newPage();

    // Idempotent: clear any stale row a previous crashed run left behind
    // before seeding, and always clear on the way out (try/finally) so a
    // failed assertion never leaves the local D1 with a dangling chapter
    // lock for the next test run.
    d1(`DELETE FROM pipeline_jobs WHERE job_id = '${JOB_ID}'`);
    try {
      d1(
        `INSERT INTO pipeline_jobs (job_id, user_id, pipeline_type, book, start_chapter, end_chapter, session_key, state) ` +
          `VALUES ('${JOB_ID}', ${auth.userId}, 'generate', 'ZEC', ${CHAPTER}, ${CHAPTER}, 's9-lock-test', 'running')`,
      );

      // Entering the dual aligner is gated only on the BOOK lock (a separate
      // mechanism — see openDualAligner/openAligner in Shell.tsx), not on an
      // active pipeline's chapter lock, so the UI stays reachable; only the
      // PATCH itself gets rejected server-side.
      await page.goto(`${BASE}/#/ZEC/${CHAPTER}/${VERSE}`);
      await page.locator("[data-note-id]").first().waitFor();
      const line = await openDualAlignerReadingLine(page, BV);
      await appendAndSaveReadingLine(page, line, BV, " LOCKED-EDIT");

      // "locked" deletes the op in the SAME transaction as the rejection —
      // there is no intermediate persisted "locked" status to observe, only
      // the op's disappearance plus the toast.
      await expect
        .poll(async () => !findVerseOp(await readOutboxOps(page), "ZEC", CHAPTER, VERSE, BV), {
          message: "the locked op was never dropped",
        })
        .toBe(true);
      await expect(page.getByText(/Edit dropped.*AI run.*mid-flight/i)).toBeVisible();

      // The differentiator: peek this tab's own pin for the verse. Released
      // (undefined) with #569; leaked (still holding the pre-lock baseline)
      // without it.
      const key = `verse:ZEC:${CHAPTER}:${VERSE}:${BV}`;
      const pinAfterDrop = await page.evaluate(
        (k) => (window as unknown as { __bePinDebug?: { peek: (k: string) => unknown } }).__bePinDebug?.peek(k),
        key,
      );
      expect(
        pinAfterDrop,
        "the draftless pin must be released on a locked exit (#565) — a leaked pin here means #569's fix regressed",
      ).toBeUndefined();

      const serverCtx = await apiRequest.newContext({ baseURL: BASE });
      const serverAuth = await mintToken(serverCtx, "verifier-s9b");
      const duringLock = await fetchChapter(serverCtx, serverAuth.token, "ZEC", CHAPTER);
      // @ts-expect-error — see the note in check (a).
      const ultDuringLock = duringLock.verses[BV][VERSE];
      expect(ultDuringLock.plain_text as string).not.toContain("LOCKED-EDIT");
      const versionDuringLock = ultDuringLock.version as number;

      // Clear the lock, then save the SAME verse again — the issue's own
      // "then after the lock clears a save of that verse lands clean".
      d1(`DELETE FROM pipeline_jobs WHERE job_id = '${JOB_ID}'`);
      await page.waitForTimeout(300);

      await appendAndSaveReadingLine(page, line, BV, " AFTER-LOCK-EDIT");
      await expect
        .poll(async () => !findVerseOp(await readOutboxOps(page), "ZEC", CHAPTER, VERSE, BV), {
          message: "the post-lock save never drained",
          timeout: 15_000,
        })
        .toBe(true);
      await expect(conflictChip(page)).toHaveCount(0);

      const afterUnlock = await fetchChapter(serverCtx, serverAuth.token, "ZEC", CHAPTER);
      // @ts-expect-error — see the note in check (a).
      const ultAfterUnlock = afterUnlock.verses[BV][VERSE];
      expect(ultAfterUnlock.plain_text as string).toContain("AFTER-LOCK-EDIT");
      expect(ultAfterUnlock.version as number).toBe(versionDuringLock + 1);

      await serverCtx.dispose();
    } finally {
      d1(`DELETE FROM pipeline_jobs WHERE job_id = '${JOB_ID}'`);
    }

    await context.close();
  });
});
