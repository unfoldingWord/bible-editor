import type { APIRequestContext, Browser, BrowserContext, Page } from "@playwright/test";

// Frontend stores its JWT here (see web/src/sync/api.ts:171).
const TOKEN_KEY = "bible-editor.auth.token";

export interface DevAuth {
  token: string;
  userId: number;
  username: string;
}

/**
 * Mint a JWT via /api/auth/dev for `username`. Requires
 * DEV_AUTH_ENABLED=true on the worker (default in api/wrangler.toml [vars]).
 */
export async function mintToken(
  request: APIRequestContext,
  username: string,
): Promise<DevAuth> {
  const res = await request.post("/api/auth/dev", { data: { username } });
  if (!res.ok()) {
    throw new Error(
      `/api/auth/dev for "${username}" returned ${res.status()}: ${await res.text()}`,
    );
  }
  return (await res.json()) as DevAuth;
}

/**
 * Create a fresh browserContext logged in as `username`. The token is injected
 * via `addInitScript` so it's present on first paint and the app skips the
 * auto-mint path in App.tsx (which would otherwise log in as "dev" and clobber
 * our identity for that context).
 */
export async function newUserContext(
  browser: Browser,
  username: string,
): Promise<{ context: BrowserContext; auth: DevAuth }> {
  const context = await browser.newContext();
  const auth = await mintToken(context.request, username);
  await context.addInitScript(
    ({ key, token }) => {
      try {
        localStorage.setItem(key, token);
      } catch {
        /* private mode etc. */
      }
    },
    { key: TOKEN_KEY, token: auth.token },
  );
  return { context, auth };
}

/** Pure-API authed request — adds Bearer header on every call. */
export function authedRequest(request: APIRequestContext, token: string) {
  return {
    get: (path: string) =>
      request.get(path, { headers: { Authorization: `Bearer ${token}` } }),
    patch: (path: string, body: unknown, expectedVersion: number) =>
      request.patch(path, {
        headers: {
          Authorization: `Bearer ${token}`,
          "If-Match": String(expectedVersion),
          "Content-Type": "application/json",
        },
        data: body,
      }),
  };
}

export interface TnRow {
  id: string;
  book: string;
  chapter: number;
  verse: number;
  ref_raw: string;
  note: string | null;
  quote: string | null;
  support_reference: string | null;
  occurrence: number | null;
  version: number;
}

export interface ChapterPayload {
  tn: TnRow[];
  tq: unknown[];
  twl: unknown[];
}

export async function fetchChapter(
  request: APIRequestContext,
  token: string,
  book: string,
  chapter: number,
): Promise<ChapterPayload> {
  const res = await request.get(`/api/chapters/${book}/${chapter}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok()) {
    throw new Error(
      `GET /api/chapters/${book}/${chapter} returned ${res.status()}: ${await res.text()}`,
    );
  }
  return (await res.json()) as ChapterPayload;
}

/**
 * Navigate `page` to a specific book/chapter/verse via the hash router. The
 * active verse matters because the resource column filters notes to the
 * active verse by default; targeting a row on verse N means navigating to N.
 */
export async function gotoVerse(
  page: Page,
  book: string,
  chapter: number,
  verse: number,
): Promise<void> {
  const hash = verse > 1 ? `#/${book}/${chapter}/${verse}` : `#/${book}/${chapter}`;
  await page.goto(`/${hash}`);
  await page.locator("[data-note-id]").first().waitFor({ timeout: 10_000 });
}

/**
 * Flush a NoteCard's pending edit. The save logic fires on
 * unmount or on active=false→true transition; the simplest reliable way to
 * trigger that from a test is to navigate to a different chapter, which
 * unmounts every note card and runs each card's unmount-flush effect.
 */
export async function flushByNavigatingAway(page: Page): Promise<void> {
  // ZEC 1 is guaranteed to exist in the seed; any other chapter would do.
  await page.goto(`/#/ZEC/1`);
  await page.locator("[data-note-id]").first().waitFor({ timeout: 10_000 });
}

/**
 * Locate the Note text field inside a NoteCard.
 *
 * Each MUI multiline TextField renders TWO <textarea> elements: the real
 * editable one, plus a hidden mirror used for auto-resize measurement
 * (`aria-hidden="true" readonly`). We filter to only the real ones, then
 * Note is the second (Quote is the first).
 */
export function noteTextarea(page: Page, rowId: string) {
  return page
    .locator(`[data-note-id="${rowId}"]`)
    .locator('textarea:not([aria-hidden="true"])')
    .nth(1);
}

/**
 * Drain the IndexedDB outbox. Polls /api/chapters until the row's note text
 * matches what we expect, OR a hard timeout. Server is the source of truth.
 */
export async function waitForServerNote(
  request: APIRequestContext,
  token: string,
  book: string,
  chapter: number,
  rowId: string,
  predicate: (note: string | null) => boolean,
  timeoutMs = 10_000,
): Promise<TnRow> {
  const start = Date.now();
  let lastSeen: TnRow | null = null;
  while (Date.now() - start < timeoutMs) {
    const chap = await fetchChapter(request, token, book, chapter);
    const row = chap.tn.find((r) => r.id === rowId);
    if (row) {
      lastSeen = row;
      if (predicate(row.note)) return row;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `waitForServerNote timed out after ${timeoutMs}ms for ${rowId}. Last note seen: ${JSON.stringify(lastSeen?.note)}`,
  );
}
