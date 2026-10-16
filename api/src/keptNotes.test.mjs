// Unit tests for the kept-notes rule (keptNotes.ts, issue #1152).
// Run from api/: node --experimental-strip-types --no-warnings src/keptNotes.test.mjs
import {
  classifyKept,
  normalizeForCompare,
  toKeptOption,
  buildKeptOption,
  loadKeptTns,
  MAX_KEPT,
} from "./keptNotes.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const AI_TEXT = { quote: "אֱלֹהִים", note: "The word **God** means X.", support_reference: "rc://*/ta/man/translate/figs-metaphor" };
const row = (over = {}) => ({
  id: "ab12", book: "EZK", chapter: 40, verse: 5, ref_raw: "40:5", preserve: 0,
  ...AI_TEXT, ...over,
});
let t = 1_000;
const ev = (action, source, user_id, payload) => ({
  action, source, user_id, created_at: (t += 10), payload_json: payload === undefined ? null : JSON.stringify(payload),
});
const aiCreate = () => ev("create", "ai_pipeline", 7, { ...AI_TEXT, ref_raw: "40:5" });
const verdict = (r, entries) => classifyKept(r, entries);

// normalize
assert(normalizeForCompare("a\\nb") === normalizeForCompare("a\nb"), "normalize: literal \\n equals newline");
assert(normalizeForCompare("don’t “x” – y…") === normalizeForCompare("don't \"x\" - y..."), "normalize: curly quotes, dashes, ellipsis");
assert(normalizeForCompare("  a   b ") === "a b", "normalize: whitespace collapse");

// preserve
assert(verdict(row({ preserve: 1 }), []).reason === "preserve", "preserve → kept even with no log");

// AI-only
assert(!verdict(row(), [aiCreate()]).kept, "AI-only note → not kept");

// person's real edit
const real = [aiCreate(), ev("update", null, 5, { note: "The word **God** means Y." })];
assert(verdict(row({ note: "The word **God** means Y." }), real).reason === "edited", "real edit → kept");

// reorder-only
assert(!verdict(row(), [aiCreate(), ev("update", null, 5, { sort_order: 300 })]).kept, "reorder-only save → not kept");

// whitespace-only
assert(!verdict(row({ note: "The word **God**  means X. " }), [aiCreate(), ev("update", null, 5, { note: "The word **God**  means X. " })]).kept, "whitespace-only save → not kept");

// edited then reverted to AI text
assert(!verdict(row(), [aiCreate(), ev("update", null, 5, { note: "changed" }), ev("update", null, 5, { note: AI_TEXT.note })]).kept, "edited then reverted → not kept");

// person-created note (empty note on create), later filled in
const created = [ev("create", null, 5, { quote: "", note: "", support_reference: "" }), ev("update", null, 5, { note: "My note" })];
assert(verdict(row({ note: "My note", quote: "", support_reference: "" }), created).reason === "edited", "person-created note, filled in → kept");

// saved AI Suggest = ordinary save by a person
assert(verdict(row({ note: "Suggested text" }), [aiCreate(), ev("update", null, 5, { note: "Suggested text" })]).kept, "saved AI Suggest → kept (D3)");

// AI rewrote after the person's edit → baseline moves
assert(!verdict(row({ note: "New AI text" }), [aiCreate(), ev("update", null, 5, { note: "mine" }), ev("update", "ai_pipeline", 7, { note: "New AI text" })]).kept, "AI rewrite after a person's edit → not kept");

// A Door43 edit the nightly sync adopted (#1155 item 3, decision C): kept only
// when the note's words changed, the same test an app save gets. The sync
// logs user_id NULL on the nightly run.
{
  // The pristine/re-seed write logs the parsed TSV row (refRaw, tags, ...).
  const synced = (over) => ev("update", "dcs_reimport", null, {
    id: "ab12", refRaw: "40:5", chapter: 40, verse: 5, occurrence: 1, tags: null, ...AI_TEXT, ...over,
  });
  assert(verdict(row({ note: "from master" }), [aiCreate(), synced({ note: "from master" })]).reason === "edited", "Door43 change to the note's words → kept (#1155 C)");
  assert(verdict(row({ quote: "אֱלֹהִים אֶחָד" }), [aiCreate(), synced({ quote: "אֱלֹהִים אֶחָד" })]).reason === "edited", "Door43 change to the quote → kept");
  assert(verdict(row({ support_reference: "rc://*/ta/man/translate/figs-simile" }), [aiCreate(), synced({ support_reference: "rc://*/ta/man/translate/figs-simile" })]).reason === "edited", "Door43 change to the support reference → kept");
  // The three-way merge logs only the columns it wrote (DB column names).
  assert(verdict(row({ note: "Fixed on Door43." }), [aiCreate(), ev("update", "dcs_reimport", null, { note: "Fixed on Door43.", tags: "x" })]).reason === "edited", "merge adoption of a Door43 note fix → kept");
  assert(verdict(row({ note: "from master" }), [aiCreate(), ev("update", "dcs_reimport", 5, { note: "from master" })]).reason === "edited", "manual pull (user id set) of a word change → kept");
  // noise
  assert(!verdict(row({ note: "The word  **God** means X.\n" }), [aiCreate(), synced({ note: "The word  **God** means X.\n" })]).kept, "Door43 spacing-only change → not kept");
  assert(!verdict(row(), [aiCreate(), synced({})]).kept, "Door43 sync that re-sends the AI text → not kept");
  assert(!verdict(row({ note: "The word “God” means X…" }), [ev("create", "ai_pipeline", 7, { ...AI_TEXT, note: 'The word "God" means X...' }), synced({ note: "The word “God” means X…" })]).kept, "Door43 curly-quote/ellipsis-only change → not kept");
  assert(!verdict(row(), [aiCreate(), synced({ tags: "keyterm" })]).kept, "Door43 tag-only change → not kept");
  assert(!verdict(row(), [aiCreate(), ev("update", "dcs_reimport", null, {})]).kept, "Door43 sync with an empty payload → not kept");
  assert(!verdict(row({ verse: 6, ref_raw: "40:6" }), [aiCreate(), synced({ refRaw: "40:6", verse: 6 })]).kept, "Door43 position-only change → not kept (words only)");
  // the baseline still moves with the AI and with reverts
  assert(!verdict(row({ note: "New AI text" }), [aiCreate(), synced({ note: "from master" }), ev("update", "ai_pipeline", 7, { note: "New AI text" })]).kept, "Door43 fix the AI later rewrote → not kept");
  assert(!verdict(row(), [aiCreate(), synced({ note: "from master" }), ev("update", null, 5, { note: AI_TEXT.note })]).kept, "Door43 fix reverted in the app to the AI text → not kept");
  assert(!verdict(row(), [aiCreate(), synced({ note: "from master" }), synced({ note: AI_TEXT.note })]).kept, "Door43 fix reverted on Door43 → not kept");
  // a create is not a change: the bulk import logs one for every row
  assert(!verdict(row(), [ev("create", "dcs_reimport", null, { ...AI_TEXT, refRaw: "40:5", chapter: 40, verse: 5 })]).kept, "Door43 import create alone → not kept");
  // a legacy note imported from Door43, then edited on Door43
  assert(verdict(row({ note: "fixed" }), [ev("create", "dcs_reimport", null, { ...AI_TEXT, refRaw: "40:5" }), synced({ note: "fixed" })]).reason === "edited", "imported note edited later on Door43 → kept");
  // restore that brings back different words
  assert(verdict(row({ note: "older words" }), [aiCreate(), ev("restore", "dcs_reimport", null, { note: "older words" })]).reason === "edited", "Door43 restore with different words → kept");
}

// migration / hint
assert(verdict(row(), [ev("create", "parallel_migration", 2, { ...AI_TEXT })]).reason === "migration", "parallel_migration → kept (D4)");
assert(!verdict(row({ note: "x" }), [ev("create", "parallel_migration", 2, { ...AI_TEXT }), ev("update", "ai_pipeline", 7, { note: "x" })]).kept, "migration note the AI later rewrote → not kept");
assert(verdict(row(), [ev("create", null, 5, { quote: "", note: "stub", support_reference: "" }), ev("update", "hint_expansion", 5, { note: "expanded" })]).reason === "hint", "hint_expansion → kept (D5)");

// repair batch
assert(!verdict(row({ quote: "fixed" }), [aiCreate(), ev("update", "quote_repair", 2, { quote: "fixed" })]).kept, "quote_repair source → not kept");
const batch = { action: "update", source: null, user_id: 2, created_at: 1789092265, payload_json: JSON.stringify({ quote: "fixed" }) };
assert(!verdict(row({ quote: "fixed" }), [aiCreate(), batch]).kept, "2026-09-11 repair batch (user 2, NULL source) → not kept");
assert(verdict(row({ quote: "fixed" }), [aiCreate(), { ...batch, created_at: 1789092999 }]).kept, "same user outside the pinned burst → kept");

// pruned history → fallback (keeps unless AI wrote last)
assert(verdict(row(), [ev("update", null, 5, { note: "x" })]).reason === "fallback", "no create → fallback keeps");
assert(!verdict(row(), [ev("update", "ai_pipeline", 7, { note: "x" })]).kept, "no create, AI wrote last → not kept");
assert(verdict(row(), []).reason === "fallback", "no log at all but updated_by set → fallback keeps");

// pruned update: AI create survives, a person's later update aged out of the log
assert(verdict(row({ note: "person wrote this" }), [aiCreate()]).reason === "unexplained", "live content the log cannot explain → kept");

// position and occurrence count as edits (#1180). Real AI creates carry the
// full position: chapter, verse, ref_raw and occurrence.
{
  const aiFull = () => ev("create", "ai_pipeline", 7, { ...AI_TEXT, book: "EZK", chapter: 40, verse: 5, ref_raw: "40:5", occurrence: 1 });
  const move = (v) => ev("update", null, 5, { ref_raw: `40:${v}`, verse: v, sort_order: 500 });
  // (a) a person moves an AI note to another verse
  assert(verdict(row({ verse: 7, ref_raw: "40:7" }), [aiFull(), move(7)]).reason === "edited", "person moves an AI note to another verse → kept (#1180 a)");
  // a person widens the reference to a range on the same leading verse
  assert(verdict(row({ ref_raw: "40:5-6" }), [aiFull(), ev("update", null, 5, { ref_raw: "40:5-6", verse: 5, sort_order: 500 })]).reason === "edited", "person widens the ref to a range → kept");
  // (b) a person changes only the occurrence
  assert(verdict(row(), [aiFull(), ev("update", null, 5, { occurrence: 2 })]).reason === "edited", "person changes only occurrence → kept (#1180 b)");
  // (c) the AI's own position writes are the baseline, not an edit
  assert(!verdict(row({ verse: 7, ref_raw: "40:7" }), [ev("create", "ai_pipeline", 7, { ...AI_TEXT, chapter: 40, verse: 7, ref_raw: "40:7", occurrence: 2 })]).kept, "AI create that sets verse/occurrence itself → not kept (#1180 c)");
  assert(!verdict(row({ verse: 7, ref_raw: "40:7" }), [aiFull(), move(6), ev("update", "ai_pipeline", 7, { ref_raw: "40:7", verse: 7, occurrence: 1 })]).kept, "AI rewrite of position after a person's move → not kept (#1180 c)");
  // (d) moved, then moved back to where the AI put it
  assert(!verdict(row(), [aiFull(), move(7), move(5)]).kept, "moved then moved back to the AI position → not kept (#1180 d)");
  assert(!verdict(row(), [aiFull(), ev("update", null, 5, { occurrence: 2 }), ev("update", null, 5, { occurrence: 1 })]).kept, "occurrence changed then changed back → not kept");
  // a person's move later overwritten by the Door43 reimport is not the person's position any more
  assert(!verdict(row(), [aiFull(), move(7), ev("update", "dcs_reimport", null, { chapter: 40, verse: 5, occurrence: 1 })]).kept, "person's move undone by reimport → not kept");
  // the torn-row heal logs only chapter/verse matching the row's own ref_raw;
  // a person's widened reference survives it
  assert(verdict(row({ ref_raw: "40:5-6" }), [aiFull(), ev("update", null, 5, { ref_raw: "40:5-6", verse: 5 }), ev("update", "dcs_reimport", null, { chapter: 40, verse: 5 })]).kept, "widened reference survives a torn-row heal → kept");
  // the reimport create logs its reference as refRaw; a save that only
  // re-sends that same reference is no edit
  const reimportCreate = ev("create", "dcs_reimport", null, { ...AI_TEXT, refRaw: "40:5", chapter: 40, verse: 5, occurrence: 1 });
  assert(!verdict(row(), [reimportCreate, ev("update", null, 5, { ref_raw: "40:5", verse: 5, sort_order: 500 })]).kept, "save re-sending a position the baseline never logged → not kept");
  // ...but its refRaw is the baseline, so a person widening the reference is an edit
  assert(verdict(row(), [reimportCreate, ev("update", null, 5, { ref_raw: "40:5-6", verse: 5, sort_order: 500 })]).kept, "person widens the reference of a reimported note → kept");
  assert(!verdict(row(), [aiFull(), ev("update", null, 5, { ref_raw: "40:5", verse: 5, sort_order: 900 })]).kept, "reorder that re-sends the same position → not kept");
  // occurrence null vs number: an AI create with occurrence 0, a person sets 1
  assert(verdict(row(), [ev("create", "ai_pipeline", 7, { ...AI_TEXT, chapter: 40, verse: 5, ref_raw: "40:5", occurrence: 0 }), ev("update", null, 5, { occurrence: 1 })]).reason === "edited", "occurrence 0 → 1 by a person → kept");
  // live position drift with no logged human change is not an edit: the
  // reimport writes ref_raw/verse without always logging them
  assert(!verdict(row({ verse: 9, ref_raw: "40:9" }), [aiFull()]).kept, "unlogged position drift alone → not kept");
  // a repair batch that moves a note is still not a person
  assert(!verdict(row({ verse: 7, ref_raw: "40:7" }), [aiFull(), { ...ev("update", "quote_repair", 2, { ref_raw: "40:7", verse: 7 }) }]).kept, "repair-source move → not kept");
}

// toKeptOption
assert(toKeptOption(row({ ref_raw: "40:12-14" })).ref === "40:12-14", "forward same-chapter range sent as is");
assert(toKeptOption(row({ ref_raw: "40:2,4", chapter: 40, verse: 2 })).ref === "40:2", "comma-list ref sent as its leading verse");
assert(toKeptOption(row({ quote: "q".repeat(501) })).quote === "", "quote over 500 chars → sent empty");
assert(toKeptOption(row({ support_reference: "s".repeat(150) })).supportReference.length === 100, "support reference cut to 100");
assert(toKeptOption(row({ note: "n".repeat(900) })).note === undefined, "note is never sent");
assert(toKeptOption(row({ ref_raw: "front:intro" })) === null, "front:intro skipped");
assert(toKeptOption(row({ id: "Ab12" })) === null, "bad id skipped");
assert(toKeptOption(row({ ref_raw: "40:9-3" })) === null, "backwards ref skipped");
assert(toKeptOption(row({ ref_raw: "40:48-41:2" })) !== null, "cross-chapter ref kept");
assert(toKeptOption(row({ ref_raw: "40:intro" })) !== null, "chapter intro ref kept");
assert(toKeptOption(row({ quote: null, support_reference: null })).quote === "", "null → empty string");

// loadKeptTns / buildKeptOption against a fake DB
function fakeEnv(candidates, logs) {
  const queries = [];
  return {
    queries,
    DB: {
      prepare(sql) {
        queries.push(sql);
        return {
          bind: (...args) => ({
            all: async () => {
              if (/FROM tn_rows/.test(sql)) return { results: candidates };
              const ids = args.slice(1);
              if (ids.length > 90) throw new Error("too many bound ids");
              return { results: ids.flatMap((id) => (logs[id] ?? []).map((e) => ({ row_key: id, ...e }))) };
            },
          }),
        };
      },
    },
  };
}
{
  const cands = [row({ id: "pres" , preserve: 1 }), row({ id: "edit", note: "Y" }), row({ id: "aiaa" }), row({ id: "bad1", ref_raw: "front:intro", preserve: 1 })];
  const logs = {
    edit: [{ ...aiCreate(), row_key: "edit" }, ev("update", null, 5, { note: "Y" })],
    aiaa: [aiCreate()],
  };
  const env = fakeEnv(cands, logs);
  const load = await loadKeptTns(env, "EZK", 40, 40);
  assert(load.rows.map((r) => r.row.id).join() === "pres,edit,bad1", "loadKeptTns keeps preserve + edited + (bad ref, filtered later)");
  assert(/updated_by IS NOT NULL/.test(env.queries[0]) && /hint = 0/.test(env.queries[0]) && /trashed_at IS NULL/.test(env.queries[0]), "candidate query excludes pristine, hint and trashed rows");
  const opts = await buildKeptOption(fakeEnv(cands, logs), "EZK", 40, 40);
  assert(opts.map((o) => o.rowId).join() === "pres,edit", "buildKeptOption drops the unsendable row");
  const hinted = await buildKeptOption(fakeEnv(cands, logs), "EZK", 40, 40, new Set(["edit"]));
  assert(hinted.map((o) => o.rowId).join() === "pres", "a hint rowId is never also kept");
}
{
  // chunking: 200 edited candidates → edit_log queried in chunks of <= 90
  const cands = Array.from({ length: 200 }, (_, i) => row({ id: `e${String(i).padStart(3, "0")}` }));
  const env = fakeEnv(cands, {});
  await loadKeptTns(env, "EZK", 1, 66);
  assert(env.queries.filter((q) => /FROM edit_log/.test(q)).length === 3, "edit_log read in 3 chunks for 200 ids");
}
{
  const cands = Array.from({ length: MAX_KEPT + 1 }, (_, i) => row({ id: `a${(i + 1000).toString(36).padStart(3, "0")}`, preserve: 1 }));
  let threw = false;
  try { await buildKeptOption(fakeEnv(cands, {}), "ISA", 1, 66); } catch (e) { threw = /too many kept notes/.test(e.message); }
  assert(threw, "over 3000 entries → error, not truncation");
}
console.log("keptNotes tests passed");
