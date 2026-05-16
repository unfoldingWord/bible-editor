import { expect, test, request as apiRequest } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  fetchChapter,
  flushByNavigatingAway,
  gotoVerse,
  mintToken,
  newUserContext,
  noteTextarea,
  waitForServerNote,
} from "./helpers";

// The standard `flushByNavigatingAway` helper waits for the destination
// chapter's note cards to appear, which can't happen while offline. This
// variant triggers the same unmount flush (the Shell remounts on chapter
// change) but doesn't wait for the destination to load.
async function flushOffline(page: Page): Promise<void> {
  await page.evaluate(() => {
    location.hash = "#/ZEC/1";
  });
  // Give the unmount effect a tick to run and enqueue the op in the outbox.
  await page.waitForTimeout(250);
}

// S7 — Offline resilience. Exercises the Level 1 stability features end-to-
// end: the outbox keeps edits durable while the connection is dropped, the
// SyncStatusBar reflects the offline state, and a reconnect drains queued
// ops without user action.

test("edits queued while offline survive and flush on reconnect", async ({ browser }) => {
  const probe = await apiRequest.newContext({ baseURL: "http://localhost:5173" });
  const probeAuth = await mintToken(probe, "probe");
  const chapter = await fetchChapter(probe, probeAuth.token, "ZEC", 6);
  const target = chapter.tn.find((r) => r.verse === 1);
  expect(target, "expected a TN row on ZEC 6:1 in the seed").toBeTruthy();
  await probe.dispose();

  const { context } = await newUserContext(browser, "alice");
  const page = await context.newPage();
  await gotoVerse(page, "ZEC", 6, target!.verse);

  // Drop the network *after* the chapter has loaded so the resource column
  // is rendered and the note card mounts. The next save attempt then has to
  // queue and wait for the connection to come back.
  await context.setOffline(true);

  const offlineText = `OFFLINE alice ${Date.now()}`;
  await noteTextarea(page, target!.id).fill(offlineText);
  await flushOffline(page);

  // The op should be durably queued in the outbox by now. Reading IndexedDB
  // directly avoids coupling the assertion to the SyncStatusBar's render
  // timing or chip text. The store schema matches outbox.ts: DB
  // "bible-editor-outbox", store "ops", with a "status" field.
  const queuedOpCount = await page.evaluate(async () => {
    const open = (name: string, version: number) =>
      new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open(name, version);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    const db = await open("bible-editor-outbox", 1);
    const ops: Array<{ status: string }> = await new Promise((resolve, reject) => {
      const tx = db.transaction("ops", "readonly");
      const req = tx.objectStore("ops").getAll();
      req.onsuccess = () => resolve(req.result as Array<{ status: string }>);
      req.onerror = () => reject(req.error);
    });
    return ops.filter((o) => o.status === "pending" || o.status === "in_flight").length;
  });
  expect(queuedOpCount, "expected at least one pending outbox op while offline").toBeGreaterThan(0);

  // While offline the server must NOT see the edit. Verify via a separate
  // request context that bypasses the offline browser network.
  const sideCtx = await apiRequest.newContext({ baseURL: "http://localhost:5173" });
  const sideAuth = await mintToken(sideCtx, "verifier");
  const beforeOnline = await fetchChapter(sideCtx, sideAuth.token, "ZEC", 6);
  const beforeRow = beforeOnline.tn.find((r) => r.id === target!.id);
  expect(beforeRow?.note ?? "").not.toBe(offlineText);

  // Reconnect — outbox listens for `online` and drains immediately.
  await context.setOffline(false);

  // Wait for the server to receive the edit. The outbox dispatcher will
  // hit the next backoff tick on reconnect; allow a generous 10s.
  const final = await waitForServerNote(
    sideCtx,
    sideAuth.token,
    "ZEC",
    6,
    target!.id,
    (n) => n === offlineText,
  );
  expect(final.note).toBe(offlineText);

  await sideCtx.dispose();
  await context.close();
});

test("server flakiness triggers retry; eventual success drains the outbox", async ({ browser }) => {
  const probe = await apiRequest.newContext({ baseURL: "http://localhost:5173" });
  const probeAuth = await mintToken(probe, "probe");
  const chapter = await fetchChapter(probe, probeAuth.token, "ZEC", 7);
  const target = chapter.tn.find((r) => r.verse === 1);
  expect(target, "expected a TN row on ZEC 7:1").toBeTruthy();
  await probe.dispose();

  const { context } = await newUserContext(browser, "bob");
  const page = await context.newPage();

  // Fail the first three PATCHes against any TN row with a 503; subsequent
  // requests pass through normally. The outbox backoff sequence is
  // 250→500→1000ms so three failures stretch ~1.75s before recovering.
  let failures = 0;
  await context.route("**/api/rows/tn/**", async (route, request) => {
    if (request.method() === "PATCH" && failures < 3) {
      failures++;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "transient" }),
      });
      return;
    }
    await route.continue();
  });

  await gotoVerse(page, "ZEC", 7, target!.verse);
  const flakyText = `FLAKY bob ${Date.now()}`;
  await noteTextarea(page, target!.id).fill(flakyText);
  await flushByNavigatingAway(page);

  const sideCtx = await apiRequest.newContext({ baseURL: "http://localhost:5173" });
  const sideAuth = await mintToken(sideCtx, "verifier-flaky");
  const final = await waitForServerNote(
    sideCtx,
    sideAuth.token,
    "ZEC",
    7,
    target!.id,
    (n) => n === flakyText,
    15_000,
  );
  expect(final.note).toBe(flakyText);
  expect(failures, "expected the 503 route to fire 3 times before the real save landed").toBe(3);

  await sideCtx.dispose();
  await context.close();
});
