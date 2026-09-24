// Pure content-dedup logic for the TN reimport (Guard 2). No I/O, no relative
// imports — unit-testable in isolation (tnDedup.test.mjs).
//
// The round-trip this prevents: pre-#183 the nightly export minted FRESH ids for
// AI notes already on master, so master ended up with two id-disjoint copies of
// one note; the reimport pulled BOTH into D1, the next export re-pushed them, and
// the copies compounded (ISA had 94 dup rows, ZEC 34). The mint engine is
// disabled now (#183/#225), so this is structural insurance: never insert a row
// whose content duplicates one that will already exist LIVE + PRISTINE under a
// different id.

// Minimal shape the dedup needs; ParsedTsvRow (bookReimport.ts) is structurally
// compatible, so the caller passes its rows straight through.
export interface TnDedupRow {
  id: string;
  chapter: number;
  verse: number;
  occurrence: number | null;
  support_reference?: string | null;
  quote?: string | null;
  note?: string | null;
}

// Content-identity key: "is this the SAME NOTE under a different id?". Excludes
// id + sort_order so two id-disjoint rows with identical content collide.
// INCLUDES occurrence — ISA 10:9 carries two genuinely distinct notes for אִם
// occurrence 1 and 2 that must never be deduped. tags is intentionally out of the
// key (it's metadata, not the note's identity). This is NOT a no-op signature:
// it deliberately omits ref_raw + tags so a re-id'd copy still collides.
export function tnContentKey(r: {
  chapter: number;
  verse: number;
  occurrence: number | null;
  support_reference?: string | null;
  quote?: string | null;
  note?: string | null;
}): string {
  return JSON.stringify([
    r.chapter,
    r.verse,
    r.occurrence ?? null,
    r.support_reference ?? null,
    r.quote ?? null,
    r.note ?? null,
  ]);
}

// Decide which INSERT candidates to skip as content-duplicates. Returns the set
// of indices into `incoming` to drop.
//
// No D1 read beyond the by-id maps the caller already holds: every row that
// persists as live+pristine after the full cycle (apply + prune) maps to an
// `incoming` row — either an existing pristine row kept/updated by its id, or a
// fresh insert. Rows absent from `incoming` are either pruned by
// softDeleteRemovedTsvRows (pristine) or human-edited (never a dedup target per
// spec), so ignoring them is correct: a master "rename" (drop id s, add id b,
// same content) inserts b and the prune drops s; a duplicate of a human note is
// left alone.
//
// `existsPristineId` — ids present in D1 as pristine (reimport-managed) rows.
// `existsAnyId` — ids present in D1 at all (pristine OR edited). A row whose id is
//   in this set is an update/no-op, not an insert candidate, so it's never skipped
//   here. We seed `claimed` from the incoming content of existing PRISTINE rows
//   (an update lands the incoming content; a no-op already matches it), then walk
//   inserts in file order so an earlier insert blocks a later identical one.
export function planTnContentDedup(
  incoming: TnDedupRow[],
  existsPristineId: Set<string>,
  existsAnyId: Set<string>,
): Set<number> {
  const claimed = new Set<string>();
  for (const r of incoming) {
    if (existsPristineId.has(r.id)) claimed.add(tnContentKey(r));
  }
  const skip = new Set<number>();
  for (let i = 0; i < incoming.length; i++) {
    const r = incoming[i];
    if (existsAnyId.has(r.id)) continue; // update/no-op, not an insert
    const key = tnContentKey(r);
    if (claimed.has(key)) {
      skip.add(i);
      continue;
    }
    claimed.add(key);
  }
  return skip;
}
