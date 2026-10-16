import { expect, test, type Page, type Route } from "@playwright/test";
import { newUserContext } from "./helpers";

// S22 — issue #1119: the outbox drain is shared by every tab of one browser
// (navigator.locks), but its result / discard announcements used to fire only
// in the tab that drained. Each case holds tab A's plain chapter refetch (the
// GET's snapshot is taken first, then held) while tab B settles a delete, and
// checks that A ends with the server's state once the stale snapshot lands:
//   - A's own tq DELETE drained by B and refused (chapter_locked): the row is
//     back in A (before #1119 A kept hiding it, and its #1108 restore never ran),
//     and A shows the "Edit dropped" toast (#1126; before, only B did);
//   - A's own tq DELETE drained by B and committed: the row stays gone;
//   - B's own tq DELETE committed during A's refetch: the row stays gone in A
//     (before #1119 the stale snapshot put it back until the next reload).

type TqRow = { id: string; verse: number };

const outboxCount = (p: Page) =>
  p.evaluate(
    () =>
      new Promise<number>((res, rej) => {
        const open = indexedDB.open("bible-editor-outbox", 1);
        open.onerror = () => rej(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const q = db.transaction("ops").objectStore("ops").count();
          q.onsuccess = () => {
            db.close();
            res(q.result);
          };
          q.onerror = () => rej(q.error);
        };
      }),
  );

// Record the row-DELETE outcomes other tabs relay to this page (#1126: poll
// for the hand-off instead of sleeping). A second channel of the same name in
// the page hears what the app's channel hears.
type OutcomeLog = { __outcomes1126?: { ch: BroadcastChannel; seen: string[] } };
const recordOutcomes = (p: Page) =>
  p.evaluate(() => {
    const w = window as unknown as OutcomeLog;
    w.__outcomes1126?.ch.close();
    const ch = new BroadcastChannel("be-row-delete-outcomes");
    const seen: string[] = [];
    ch.onmessage = (e) => seen.push(`${e.data?.kind}:${e.data?.op?.target?.id}`);
    w.__outcomes1126 = { ch, seen };
  });
const heardOutcome = (p: Page, kind: string, id: string) =>
  expect
    .poll(() => p.evaluate((s) => (window as unknown as OutcomeLog).__outcomes1126?.seen.includes(s) ?? false, `${kind}:${id}`), {
      timeout: 10_000,
    })
    .toBe(true);

const idText = (p: Page, id: string) => p.getByText(id, { exact: true });
const deleteButton = (p: Page, id: string) =>
  idText(p, id)
    .locator('xpath=ancestor::*[.//*[@data-testid="DeleteOutlineIcon"]][1]')
    .locator('button:has([data-testid="DeleteOutlineIcon"])');

test("a tq delete settled by another tab during this tab's plain refetch ends with the server's state", async ({ browser }) => {
  test.setTimeout(120_000);
  const { context } = await newUserContext(browser, "tabs1119");
  const serverTq = async (): Promise<TqRow[]> => {
    const res = await context.request.get("/api/chapters/ZEC/1");
    expect(res.ok()).toBe(true);
    return ((await res.json()) as { tq: TqRow[] }).tq;
  };
  const rows = await serverTq();
  expect(rows.length).toBeGreaterThanOrEqual(3);
  const [refusedRow, committedRow, otherTabRow] = rows;

  const tabA = await context.newPage();
  const tabB = await context.newPage();
  const show = async (p: Page, row: TqRow) => {
    await p.goto(`/#/ZEC/1/${row.verse}`);
    await p.getByRole("button", { name: /^Questions/ }).click({ timeout: 20_000 });
    await expect(idText(p, row.id)).toHaveCount(1, { timeout: 20_000 });
  };

  // Tab A leaves the chapter and comes back: a plain refetch. Its GET is sent
  // to the server at once (the snapshot), and the response is held until
  // `land()`. Any later chapter GET (the socket's merging refetch after the
  // room reopens) is held until `finish()`, so what A shows in between is the
  // plain refetch's result alone, not a later refetch healing it.
  const holdPlainRefetch = async (row: TqRow) => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let releaseLater!: () => void;
    const later = new Promise<void>((r) => (releaseLater = r));
    let fetched!: () => void;
    const sent = new Promise<void>((r) => (fetched = r));
    let delivered!: () => void;
    const landed = new Promise<void>((r) => (delivered = r));
    let n = 0;
    const handler = async (route: Route) => {
      const first = n++ === 0;
      const response = await route.fetch();
      if (first) fetched();
      await (first ? gate : later);
      await route.fulfill({ response }).catch(() => {});
      if (first) delivered();
    };
    await tabA.route("**/api/chapters/ZEC/1", handler);
    // Leave for chapter 2 and wait for its load, so coming back is a fresh
    // plain refetch of chapter 1 (#1126: no fixed sleep).
    const leftFor2 = tabA.waitForResponse((r) => r.url().endsWith("/api/chapters/ZEC/2"));
    await tabA.evaluate(() => (location.hash = "#/ZEC/2/1"));
    await leftFor2;
    await tabA.evaluate((v) => (location.hash = `#/ZEC/1/${v}`), row.verse);
    await sent;
    return {
      land: async () => {
        release();
        await landed;
        // The chapter change switched the resource panel back to Notes.
        await tabA.getByRole("button", { name: /^Questions/ }).click();
      },
      finish: async () => {
        releaseLater();
        await tabA.unroute("**/api/chapters/ZEC/1", handler);
      },
    };
  };

  // A's own delete, drained by B.
  for (const [outcome, row] of [["refused", refusedRow], ["committed", committedRow]] as const) {
    await show(tabA, row);
    await show(tabB, row);
    // B holds the drain lock, so A's DELETE stays queued until B drains it;
    // A's own attempts never reach the network either.
    await tabB.evaluate(
      () =>
        new Promise<void>((res) => {
          void navigator.locks.request(
            "be-outbox-drain",
            () => new Promise<void>((release) => {
              (window as unknown as { __release1119: () => void }).__release1119 = release;
              res();
            }),
          );
        }),
    );
    const abortA = (route: Route) => (route.request().method() === "DELETE" ? route.abort() : route.continue());
    await tabA.route("**/api/rows/tq/**", abortA);
    await deleteButton(tabA, row.id).click();
    await expect(idText(tabA, row.id)).toHaveCount(0);
    await expect.poll(() => outboxCount(tabA)).toBe(1);

    const refetchA = await holdPlainRefetch(row);
    await recordOutcomes(tabA);

    let deleteSeen = false;
    const drainB = async (route: Route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      deleteSeen = true;
      if (outcome === "refused") {
        return route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({ error: "chapter_locked", jobId: "live-1119", pipelineType: "tq", startedAt: Math.floor(Date.now() / 1000) }),
        });
      }
      return route.continue();
    };
    await tabB.route("**/api/rows/tq/**", drainB);
    await tabB.evaluate(() => {
      (window as unknown as { __release1119: () => void }).__release1119();
      window.dispatchEvent(new Event("focus"));
    });
    await expect
      .poll(
        async () => {
          if (!deleteSeen) await tabB.evaluate(() => window.dispatchEvent(new Event("focus")));
          return deleteSeen;
        },
        { timeout: 20_000, intervals: [500] },
      )
      .toBe(true);
    await expect.poll(() => outboxCount(tabB), { timeout: 10_000 }).toBe(0);
    await heardOutcome(tabA, outcome === "refused" ? "abandoned" : "committed", row.id); // B's announcement reached A
    if (outcome === "refused") {
      // #1126 item 1: the tab that made the delete says why the row comes back.
      await expect
        .soft(tabA.getByText(/Edit dropped.*AI run.*mid-flight/i).first(), "A shows the Edit dropped toast")
        .toBeVisible({ timeout: 10_000 });
    }
    await refetchA.land();
    await tabA.unroute("**/api/rows/tq/**", abortA);
    await tabB.unroute("**/api/rows/tq/**", drainB);

    const onServer = (await serverTq()).some((r) => r.id === row.id);
    if (outcome === "refused") {
      expect(onServer).toBe(true);
      await expect.soft(idText(tabA, row.id), "A shows the row the server kept").toHaveCount(1, { timeout: 10_000 });
    } else {
      expect(onServer).toBe(false);
      await expect.soft(idText(tabA, row.id)).toHaveCount(0);
      // A negative check: watch for the row coming back over a short window.
      await tabA.waitForTimeout(2_000);
      await expect.soft(idText(tabA, row.id), "A still hides the committed row").toHaveCount(0);
    }
    await refetchA.finish();
  }

  // B's own delete, committed during A's plain refetch.
  await show(tabA, otherTabRow);
  await show(tabB, otherTabRow);
  const refetchA = await holdPlainRefetch(otherTabRow);
  await recordOutcomes(tabA);
  await deleteButton(tabB, otherTabRow.id).click();
  await expect.poll(() => outboxCount(tabB), { timeout: 10_000 }).toBe(0);
  expect((await serverTq()).some((r) => r.id === otherTabRow.id)).toBe(false);
  await heardOutcome(tabA, "committed", otherTabRow.id);
  await refetchA.land();
  await expect.soft(idText(tabA, otherTabRow.id)).toHaveCount(0);
  // A negative check: watch for the row coming back over a short window.
  await tabA.waitForTimeout(2_000);
  await expect.soft(idText(tabA, otherTabRow.id), "A does not resurrect another tab's committed delete").toHaveCount(0);
  await refetchA.finish();

  await context.close();
});
