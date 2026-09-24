// Pure core of the alignment-source canonize repair (GitHub issue #945).
//
// The CLI (scripts/repair-canonize-alignment.mjs) owns arguments, dump
// loading, the lock guard, SQL and reporting. This module owns the per-verse
// transform and the verifier that decides whether a verse may be written.
//
// Tests: scripts/lib/canonizeAlignment.test.mjs (`npm run test:scripts`).
// Needs `node --experimental-strip-types`: it imports the REAL production
// matcher (api/src/canonizeHebrew.ts) and source-word collector
// (api/src/importParsers.ts) rather than a copy, so the repair cannot drift from
// what ingest and master adoption already do.
//
// ── THE DEFECT ─────────────────────────────────────────────────────────────
//   A ULT/UST `\zaln-s x-content` whose Hebrew does not byte-match the UHB word
//   it aligns to, e.g. JER 28:12 ULT "after":
//     milestone content  אַ⁠חֲרֵי   (U+2060 word joiner where the accent was)
//     UHB \w text        אַ֠חֲרֵי   (U+05A0 telisha gedola)
//   The highlighter keys on those bytes, so the two words never link.
//   canonizeAlignmentSource fixes this at ingest and adoption, but it was added
//   2026-07-13 and never ran over rows already in D1.

import { canonizeAlignmentSource } from "../../api/src/canonizeHebrew.ts";
import { collectSourceWords } from "../../api/src/importParsers.ts";

// Attributes the canonizer is allowed to change, and only on zaln milestones.
const MUTABLE_ZALN_ATTRS = new Set(["content", "lemma"]);

// ── source words ───────────────────────────────────────────────────────────

// UHB rows → { words: Map("ch:v" → SourceWord[]), unusable: Map("ch:v" → why) }.
// `words` is built exactly like bookReimport.ts step 6 (srcByKey) and
// pipelineImport.ts loadUhbSourceWords: parse content_json, take verseObjects,
// collectSourceWords. Production silently skips an unparseable source row; a
// one-time repair must not, because a missing verse inside a bridge would
// narrow the source words and can canonize onto the wrong word. So every
// problem key is RECORDED in `unusable` (unparseable, or duplicated with
// differing content) and the caller refuses any verse that touches one.
export function buildSourceIndex(uhbRows) {
  const words = new Map();
  const unusable = new Map();
  const seen = new Map(); // key -> content_json
  for (const r of uhbRows) {
    const key = `${Number(r.chapter)}:${Number(r.verse)}`;
    if (seen.has(key)) {
      if (seen.get(key) !== r.content_json) {
        unusable.set(key, "duplicate UHB rows with differing content");
        words.delete(key);
      }
      continue;
    }
    seen.set(key, r.content_json);
    try {
      const vo = JSON.parse(r.content_json).verseObjects;
      if (!Array.isArray(vo)) throw new Error("no verseObjects array");
      words.set(key, collectSourceWords(vo));
    } catch (e) {
      unusable.set(key, `UHB content_json unusable: ${e.message}`);
    }
  }
  return { words, unusable };
}

// Which UHB verses a target verse needs, and whether each is usable. Returns
// { words, problems } — `problems` non-empty means the caller must refuse:
// a verse in [verse, verse_end] is absent from the dump or unusable.
export function sourceCoverage(index, chapter, verse, verseEnd) {
  const ch = Number(chapter);
  const v = Number(verse);
  const ve = verseEnd == null ? null : Number(verseEnd);
  const end = ve != null && Number.isFinite(ve) && ve >= v ? ve : v;
  const problems = [];
  for (let i = v; i <= end; i++) {
    const key = `${ch}:${i}`;
    if (index.unusable.has(key)) problems.push(`UHB ${key}: ${index.unusable.get(key)}`);
    else if (!index.words.has(key)) problems.push(`UHB ${key} missing from the dump`);
  }
  return { words: sourceWordsForRange(index.words, ch, v, verseEnd), problems };
}

// ── dump hygiene ───────────────────────────────────────────────────────────

// Keys every target row must CARRY (a null value is fine; an absent key means
// the SELECT left the column out, and e.g. a missing verse_end would silently
// disable bridge handling).
const REQUIRED_KEYS = ["book", "chapter", "verse", "verse_end", "bible_version", "version", "content_json", "plain_text", "updated_by"];

// Why a target row cannot be used, or null. A missing identity column would
// otherwise produce `WHERE book = NULL`, which silently matches nothing.
export function rowIdentityProblem(row) {
  for (const k of REQUIRED_KEYS) if (!(k in row)) return `column '${k}' absent from the dump row`;
  for (const col of ["book", "bible_version"]) {
    if (typeof row[col] !== "string" || row[col].trim() === "") return `${col} missing (got ${JSON.stringify(row[col])})`;
  }
  for (const col of ["chapter", "verse", "version"]) {
    if (row[col] == null || !Number.isInteger(Number(row[col]))) return `${col} missing or not an integer (got ${JSON.stringify(row[col])})`;
  }
  if (row.content_json == null) return "content_json is NULL";
  return null;
}

// Collapse rows that appear more than once (the same file passed twice, a
// re-dump beside an old dump). Identical duplicates collapse silently; rows
// whose version or content differ are returned in `conflicts` and must be
// refused — there is no way to know which is current.
export function dedupeRows(rows) {
  const byKey = new Map();
  const conflicts = new Map(); // key -> why
  for (const r of rows) {
    const key = `${r.book}/${r.chapter}/${r.verse}/${r.bible_version}`;
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, r); continue; }
    if (prev.version !== r.version || prev.content_json !== r.content_json || prev.verse_end !== r.verse_end) {
      conflicts.set(key, `duplicate dump rows disagree (version ${prev.version} vs ${r.version})`);
    }
  }
  return { rows: [...byKey.values()], conflicts };
}

// Make a data value safe inside a `--` SQL comment: escape CR/LF and every
// other control character, so nothing from the dump can end the comment and
// turn the rest of the line into a live statement.
export function commentSafe(s) {
  return String(s).replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`);
}

// Source words for a target verse, unioned across a verse bridge (verse_end).
// Same logic as bookReimport.ts sourceWordsForVerseRange and pipelineImport.ts
// sourceWordsForRange; both are module-private, so it is restated here.
export function sourceWordsForRange(map, chapter, verse, verseEnd) {
  const ch = Number(chapter);
  const v = Number(verse);
  const ve = verseEnd == null ? null : Number(verseEnd);
  const end = ve != null && Number.isFinite(ve) && ve >= v ? ve : v;
  if (end === v) return map.get(`${ch}:${v}`) ?? [];
  const out = [];
  for (let i = v; i <= end; i++) {
    const ws = map.get(`${ch}:${i}`);
    if (ws) out.push(...ws);
  }
  return out;
}

// ── verifier ───────────────────────────────────────────────────────────────

// Compare two parsed content_json documents. PASSES only when they are
// deep-equal except for `content` / `lemma` string values on nodes that are
// `type:"milestone", tag:"zaln"` in BOTH trees. Everything else — node count,
// key sets, order, `\w` text/occurrence, text nodes, other milestone attrs,
// top-level keys — must be identical. Returns { ok, changes, why }.
export function verifyOnlyZalnSourceChanged(before, after) {
  const changes = [];
  let why = null;
  const fail = (path, msg) => {
    if (!why) why = `${path}: ${msg}`;
  };
  const isZaln = (o) => o && typeof o === "object" && o.type === "milestone" && o.tag === "zaln";

  const walk = (a, b, path) => {
    if (why) return;
    if (a === b) return;
    if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") {
      fail(path, `value differs (${JSON.stringify(a)} → ${JSON.stringify(b)})`);
      return;
    }
    if (Array.isArray(a) !== Array.isArray(b)) return fail(path, "array/object mismatch");
    if (Array.isArray(a)) {
      if (a.length !== b.length) return fail(path, `length ${a.length} → ${b.length}`);
      for (let i = 0; i < a.length; i++) walk(a[i], b[i], `${path}[${i}]`);
      return;
    }
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.join("\u0000") !== kb.join("\u0000")) {
      return fail(path, `keys differ (${ka.join(",")} → ${kb.join(",")})`);
    }
    const zaln = isZaln(a) && isZaln(b);
    const change = {};
    for (const k of ka) {
      if (zaln && MUTABLE_ZALN_ATTRS.has(k) && typeof a[k] === "string" && typeof b[k] === "string") {
        if (a[k] !== b[k]) change[k] = { before: a[k], after: b[k] };
        continue;
      }
      walk(a[k], b[k], `${path}.${k}`);
    }
    if (Object.keys(change).length) {
      changes.push({ path, strong: typeof a.strong === "string" ? a.strong : "", ...change });
    }
  };
  walk(before, after, "$");
  return why ? { ok: false, changes, why } : { ok: true, changes, why: null };
}

// ── classification ─────────────────────────────────────────────────────────

// What a change means to a translator. The highlighter compares Hebrew through
// web/src/lib/hebrew.ts nfc() (NFC only, joiners kept), so:
//   "visible"    — content differs from the UHB even after NFC: the English
//                  word does not highlight today (the JER 28:12 class).
//   "mark_order" — content equal under NFC; only combining-mark ORDER moves to
//                  the UHB's bytes. Invisible in the app today.
//   "lemma_only" — content untouched; only x-lemma adopts the UHB lemma.
export function classifyChange(c) {
  if (c.content) {
    return c.content.before.normalize("NFC") !== c.content.after.normalize("NFC") ? "visible" : "mark_order";
  }
  return "lemma_only";
}

// Hebrew skeleton for the "declined" report only: NFC, drop points/accents and
// invisible joiners. Mirrors the canonizer's loosest tier; it never decides a
// write, it only explains what was left alone.
function skeleton(s) {
  let out = "";
  for (const ch of String(s).normalize("NFC")) {
    const c = ch.codePointAt(0);
    if ((c >= 0x591 && c <= 0x5bd) || c === 0x5bf || c === 0x5c1 || c === 0x5c2 || c === 0x5c4 || c === 0x5c5 || c === 0x5c7) continue;
    if (c === 0x2060 || c === 0x200d || c === 0xfeff) continue;
    out += ch;
  }
  return out;
}

// Milestones that are STILL a visible mismatch (NFC content matches no UHB word
// of the verse) yet share a consonant skeleton with one. The canonizer left
// them alone, normally because two UHB words fit and it fails closed rather
// than guess. They need a human in the aligner.
export function declinedVisible(verseObjects, sourceWords) {
  const nfcSet = new Set(sourceWords.map((w) => w.text.normalize("NFC")));
  const out = [];
  const walk = (nodes) => {
    for (const o of nodes) {
      if (!o || typeof o !== "object") continue;
      if (o.type === "milestone" && o.tag === "zaln" && typeof o.content === "string" && !nfcSet.has(o.content.normalize("NFC"))) {
        const sk = skeleton(o.content);
        const candidates = sourceWords.filter((w) => skeleton(w.text) === sk);
        if (candidates.length) {
          const strong = typeof o.strong === "string" ? o.strong : "";
          const sameStrong = candidates.filter((w) => w.strong === strong);
          const distinct = [...new Set(sameStrong.map((w) => w.text))];
          out.push({
            strong,
            content: o.content,
            candidates: [...new Set(candidates.map((w) => w.text))],
            reason:
              sameStrong.length === 0
                ? "no UHB word with this Strong's shares the skeleton"
                : distinct.length > 1
                  ? "ambiguous: several UHB words fit"
                  : "no canonizer tier matched",
          });
        }
      }
      if (Array.isArray(o.children)) walk(o.children);
    }
  };
  walk(verseObjects);
  return out;
}

// ── per-verse repair ───────────────────────────────────────────────────────

// Returns one of:
//   { status: "clean", declined }              canonizer changed nothing
//   { status: "no_source" }                    no UHB words for this verse
//   { status: "repaired", newContentJson, changes, declined }
// `changes[].kind` is classifyChange(); `declined` is declinedVisible().
//   { status: "refused", why }
// `newContentJson` is only produced when the verifier passes.
export function repairVerse(contentJson, sourceWords) {
  if (!sourceWords || sourceWords.length === 0) return { status: "no_source" };
  let before;
  let after;
  try {
    before = JSON.parse(contentJson);
    after = JSON.parse(contentJson);
  } catch (e) {
    return { status: "refused", why: `content_json does not parse: ${e.message}` };
  }
  if (!after || !Array.isArray(after.verseObjects)) {
    return { status: "refused", why: "content_json has no verseObjects array" };
  }
  const n = canonizeAlignmentSource(after.verseObjects, sourceWords);
  const declined = declinedVisible(after.verseObjects, sourceWords);
  if (n === 0) return { status: "clean", declined };
  const v = verifyOnlyZalnSourceChanged(before, after);
  if (!v.ok) return { status: "refused", why: `verifier: ${v.why}` };
  if (v.changes.length === 0) return { status: "clean", declined };
  const changes = v.changes.map((c) => ({ ...c, kind: classifyChange(c) }));
  return { status: "repaired", newContentJson: JSON.stringify(after), changes, declined };
}

// ── reporting helper ───────────────────────────────────────────────────────

// Every non-ASCII code point (and every ASCII control character) as \uXXXX, so
// a word joiner vs an accent is visible, and the result is comment-safe.
export function uEscape(s) {
  let out = "";
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    out += c >= 0x20 && c < 0x7f ? ch : c > 0xffff ? `\\u{${c.toString(16).toUpperCase()}}` : `\\u${c.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return out;
}
