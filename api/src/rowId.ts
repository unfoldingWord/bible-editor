// Canonical bible-editor row-id helpers — generation, validation, repair.
//
// Pure + dependency-free (no relative imports, no I/O) so they can be unit-tested
// in isolation (rowId.test.mjs) and imported anywhere without pulling the Hono
// router. The TN TSV id grammar is ^[a-z][a-z0-9]{3}$ — 4 chars, the first a
// LETTER. A digit-first id can't legally exist in a TN TSV (it breaks
// round-tripping) and bp-assistant rejects it when echoing hint rowIds, so the
// first position draws from letters only; the remaining three are alphanumeric.

// `l` and `o` are omitted to avoid l/1 and o/0 confusion (matches the legacy
// minting alphabet). 23 letters, then digits 2-9 for the alphanumeric positions.
const ID_LETTERS = "abcdefghijkmnpqrstuvwxyz";
const ID_CHARS = ID_LETTERS + "23456789";

export const ROW_ID_RE = /^[a-z][a-z0-9]{3}$/;
export const isValidRowId = (s: string): boolean => ROW_ID_RE.test(s);

// Mint a brand-new random id. Used by the create path (rows.ts) and the AI
// auto-apply path (pipelineImport.ts) when bp-assistant didn't supply a usable id.
export function newRowId(): string {
  let out = ID_LETTERS[Math.floor(Math.random() * ID_LETTERS.length)];
  for (let i = 0; i < 3; i++) out += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  return out;
}

// Deterministically rewrite a malformed row id into a valid one. A NO-OP for any
// well-formed id, so it's transparent for the overwhelming majority of rows — it
// only ever changes an id that violates the grammar (e.g. the digit-first ids an
// old newRowId bug minted before PR #225). Used by the DCS→D1 reimport as
// defense-in-depth so a still-dirty master can't re-introduce an illegal id.
//
// Unlike newRowId(), this mapping MUST be pure + stable (no randomness): the
// reimport's apply, diff-gate, and prune paths each coerce independently and have
// to land on the same id, and a given bad id must map to the same good id every
// night — a random mint would make a retried/re-run import insert a *second*
// copy. Derived from an FNV-1a hash of the original id over the id alphabet. A
// collision with an existing id just means the insert's ON CONFLICT DO NOTHING
// fires (the row isn't inserted this cycle) — never corruption or a duplicate.
//
// Characters are drawn from avalanched copies of the hash (`mix`, below), the
// same construction deriveAltRowId uses. Issue #428: this used to index
// ID_CHARS with the raw FNV state, which reaches only 96 distinct outputs (see
// the note on `mix`), so two malformed ids in one book could coerce to the same
// id and the second row was silently skipped by ON CONFLICT DO NOTHING.
//
// Changing the mapping was safe because nothing was coerced when it changed.
// The mapping only matters while Door43 master still carries the raw
// malformed id (once master holds a valid id, coerceRowId is a no-op for it),
// so the count that matters is master's. Measured 2026-09-28:
// all 198 master TSVs the reimport reads (unfoldingWord/en_tn, en_tq, en_twl,
// `{tn,tq,twl}_{BOOK}.tsv` for all 66 books, ID column) held 235,244 rows and
// 0 ids failing ROW_ID_RE; prod D1 held 0 grammar-violating ids across
// tn_rows/tq_rows/twl_rows (186,801 rows, live and tombstoned). So no
// previously coerced id existed to keep stable, and no legacy lookup is needed.
// If master ever carries a malformed id again, that id gets the new mapping on
// its first reimport and keeps it every night after.
export function coerceRowId(id: string): string {
  if (isValidRowId(id)) return id;
  let h = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i++) {
    h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  }
  let out = ID_LETTERS[mix(h) % ID_LETTERS.length];
  for (let i = 0; i < 3; i++) {
    h = Math.imul(h ^ (i + 1), 16777619) >>> 0;
    out += ID_CHARS[mix(h) % ID_CHARS.length];
  }
  return out;
}

// Avalanche a 32-bit FNV state before indexing an alphabet with it. Bare
// `h = imul(h, PRIME); h % ID_CHARS.length` looks fine but collapses the
// output space: ID_CHARS.length is 32, and multiplication mod 2^32 leaves the
// low 5 bits a closed cycle (`low5 *= 19 mod 32`), so all three trailing
// characters would be a pure function of `h mod 32` — 96 reachable ids in
// total instead of 24*32^3. rowId.test.mjs asserts the reachable-output count
// for both coerceRowId and deriveAltRowId so this can't regress unnoticed.
function mix(x: number): number {
  x = Math.imul(x ^ (x >>> 15), 2246822507) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 3266489909) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

// Derive the Nth alternate id for a row whose preferred id is unavailable —
// held by a tombstone (soft-deleted rows keep their `(book, id)` PK slot
// forever) or by a live row belonging to a different chapter.
//
// Like coerceRowId and for the same reason, this MUST be pure + stable. When a
// preferred id is unavailable it stays unavailable, so a re-run of the same
// import walks the identical candidate chain, finds the row the previous run
// created, and UPDATEs it. A random mint would instead insert a *second* copy
// of the same row on every re-run — the AI-content duplication failure this
// codebase has repeatedly had to clean up by hand.
//
// Same FNV-1a construction as coerceRowId, with the attempt folded into the
// hash so successive attempts diverge. Unlike coerceRowId this is NOT a no-op
// for a well-formed id: the caller has already established that the input id
// cannot be used.
export function deriveAltRowId(id: string, attempt: number): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < id.length; i++) {
    h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0;
  }
  h = Math.imul(h ^ (attempt + 1), 16777619) >>> 0;
  // Each character is drawn from an avalanched copy of the hash (`mix`). A
  // collapsed output pool is dense enough that two colliding proposals in one
  // chapter can derive the SAME alternate id, at which point the second
  // silently UPDATEs over the first.
  let out = ID_LETTERS[mix(h) % ID_LETTERS.length];
  for (let i = 0; i < 3; i++) {
    h = Math.imul(h ^ (i + 1), 16777619) >>> 0;
    out += ID_CHARS[mix(h) % ID_CHARS.length];
  }
  return out;
}
