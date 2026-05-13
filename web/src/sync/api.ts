// Typed fetch helpers for the editor API. All paths are relative (Vite's
// dev proxy points /api/* at the local Worker; production serves the SPA
// from the same origin as the Worker).

export type RowKind = "tn" | "tq" | "twl";

export interface TnRow {
  id: string;
  book: string;
  chapter: number;
  verse: number;
  ref_raw: string;
  tags: string | null;
  support_reference: string | null;
  quote: string | null;
  occurrence: number | null;
  note: string | null;
  sort_order: number | null;
  version: number;
  restored_from_version: number | null;
  updated_by: number | null;
  updated_at: number;
  deleted_at: number | null;
}

export interface TqRow {
  id: string;
  book: string;
  chapter: number;
  verse: number;
  ref_raw: string;
  tags: string | null;
  quote: string | null;
  occurrence: number | null;
  question: string | null;
  response: string | null;
  version: number;
  restored_from_version: number | null;
  updated_by: number | null;
  updated_at: number;
  deleted_at: number | null;
}

export interface TwlRow {
  id: string;
  book: string;
  chapter: number;
  verse: number;
  ref_raw: string;
  tags: string | null;
  orig_words: string | null;
  occurrence: number | null;
  tw_link: string | null;
  sort_order: number | null;
  version: number;
  restored_from_version: number | null;
  updated_by: number | null;
  updated_at: number;
  deleted_at: number | null;
}

export interface VerseDto {
  book: string;
  chapter: number;
  verse: number;
  bible_version: string;
  plain_text: string | null;
  version: number;
  updated_by: number | null;
  updated_at: number;
  content: unknown;
}

export interface VerseStatus {
  book: string;
  chapter: number;
  verse: number;
  done: 0 | 1;
  updated_at: number;
}

export interface ChapterPayload {
  book: string;
  chapter: number;
  verses: Record<string, Record<number, VerseDto>>;
  tn: TnRow[];
  tq: TqRow[];
  twl: TwlRow[];
  verseStatuses: VerseStatus[];
}

export interface BookSummary {
  book: string;
  chapters: Array<{
    chapter: number;
    verses: number;
    tn: number;
    tq: number;
    twl: number;
  }>;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: unknown,
  ) {
    super(message);
  }
}

// Bearer token storage. The token is opaque to the client — it carries the
// user id in its `sub` claim and the worker verifies HS256 against the
// shared JWT_SIGNING_KEY. localStorage is good-enough for a 7-month tactical
// tool; revisit if the app starts handling sensitive data (the obvious next
// step would be httpOnly cookies, which also requires SameSite=Lax + CSRF).
const TOKEN_KEY = "bible-editor.auth.token";
let cachedToken: string | null | undefined;

export function getAuthToken(): string | null {
  if (cachedToken !== undefined) return cachedToken;
  try {
    cachedToken = typeof localStorage !== "undefined" ? localStorage.getItem(TOKEN_KEY) : null;
  } catch {
    cachedToken = null;
  }
  return cachedToken;
}

export function setAuthToken(token: string | null) {
  cachedToken = token;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode etc. */
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  const token = getAuthToken();
  if (token && !headers.Authorization) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(path, { ...init, headers });
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, `HTTP ${res.status}`, body);
  }
  return (await res.json()) as T;
}

export interface DevAuthResponse {
  token: string;
  userId: number;
  username: string;
  expiresIn: number;
}

// Dev-only sign-in. Mints a JWT for `username`, creating a users row on
// first use. Only works while the worker has DEV_AUTH_ENABLED=true and a
// JWT_SIGNING_KEY configured. Production should route through DCS OAuth
// (not yet wired — see docs/plan.md).
export async function devSignIn(username = "dev"): Promise<DevAuthResponse> {
  const res = await fetch(`/api/auth/dev`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, `HTTP ${res.status}`, body);
  }
  const data = (await res.json()) as DevAuthResponse;
  setAuthToken(data.token);
  return data;
}

export interface RowHistoryUser {
  id: number;
  username: string | null;
  full_name: string | null;
}

export interface RowHistoryEntry {
  version: number;
  // "imported" is synthesized server-side for rows that never had a real
  // `create` entry — the server fills it in from the current row state so
  // every row has a v1 anchor in its history.
  action: "create" | "update" | "delete" | "restore" | "imported";
  created_at: number;
  user: RowHistoryUser | null;
  // Just the fields that changed in this entry, intersected with the
  // kind-specific content fields the server tracks.
  patch: Record<string, unknown>;
  // The full reconstructed value of every content field at this version,
  // after this entry was applied.
  snapshot: Record<string, unknown>;
  synthetic: boolean;
  // Set when this entry was created by "switch to v{N}" from the history
  // dialog. The snapshot is identical to v{N}'s, so the UI hides these
  // phantom entries and surfaces the restored version as current instead.
  restored_from_version: number | null;
}

export interface RowHistory {
  versions: RowHistoryEntry[];
}

export interface Catalogs {
  supportReferences: string[];
  twLinks: string[];
}

export interface BookListEntry {
  book: string;
  imported_at: number;
}

// Translation-note AI draft endpoint (proxied through this Worker; the
// shared bot lives at uw-bt-bot.fly.dev). Schema is the bot's; keep in
// sync with its zod definition. The Worker only adds the BT_API_TOKEN
// bearer and forwards the body verbatim, so types live on this side.
export interface TnQuickRequest {
  ref: {
    book: string;
    chapter: number;
    verse: number;
  };
  issueType: string;
  ult: {
    selection: string;
    verse: string;
    context: { prev5: string[]; next5: string[] };
  };
  ust: {
    selection: string;
    verse: string;
    context: { prev5: string[]; next5: string[] };
  };
  hebrewGuess: string;
  model?: "sonnet" | "opus";
}

export interface TnQuickResponse {
  quote: string;
  note: string;
  warnings: string[];
}

export const api = {
  getBookSummary: (book: string) =>
    request<BookSummary>(`/api/chapters/${encodeURIComponent(book)}`),

  getChapter: (book: string, chapter: number) =>
    request<ChapterPayload>(`/api/chapters/${encodeURIComponent(book)}/${chapter}`),

  getCatalogs: () => request<Catalogs>(`/api/catalogs`),

  getBooks: () => request<{ books: BookListEntry[] }>(`/api/books`),

  setVerseDone: (book: string, chapter: number, verse: number, done: boolean) =>
    request<VerseStatus>(
      `/api/chapters/${encodeURIComponent(book)}/${chapter}/${verse}/status`,
      { method: "PATCH", body: JSON.stringify({ done }) },
    ),

  createRow: <T = unknown>(kind: RowKind, body: Record<string, unknown>) =>
    request<T>(`/api/rows/${kind}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  getRowHistory: (kind: RowKind, id: string) =>
    request<RowHistory>(
      `/api/rows/${kind}/${encodeURIComponent(id)}/history`,
    ),

  patchRow: <T = unknown>(
    kind: RowKind,
    id: string,
    expectedVersion: number,
    patch: Record<string, unknown>,
    opts?: { restoredFromVersion?: number | null },
  ) =>
    request<T>(`/api/rows/${kind}/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "If-Match": String(expectedVersion) },
      body: JSON.stringify(
        opts && typeof opts.restoredFromVersion === "number"
          ? { ...patch, restored_from_version: opts.restoredFromVersion }
          : patch,
      ),
    }),

  deleteRow: (kind: RowKind, id: string, expectedVersion: number) =>
    request<{ ok: true }>(`/api/rows/${kind}/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { "If-Match": String(expectedVersion) },
    }),

  patchVerse: <T = unknown>(
    book: string,
    chapter: number,
    verse: number,
    bibleVersion: string,
    expectedVersion: number,
    payload: { content: unknown; plain_text?: string | null },
  ) =>
    request<T>(
      `/api/verses/${encodeURIComponent(book)}/${chapter}/${verse}/${encodeURIComponent(bibleVersion)}`,
      {
        method: "PATCH",
        headers: { "If-Match": String(expectedVersion) },
        body: JSON.stringify(payload),
      },
    ),

  tnQuick: (body: TnQuickRequest, signal?: AbortSignal) =>
    request<TnQuickResponse>(`/api/tn-quick`, {
      method: "POST",
      body: JSON.stringify(body),
      signal,
    }),
};
