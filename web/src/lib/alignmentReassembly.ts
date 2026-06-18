// Occurrence-keyed alignment reassembly — the primary edit engine.
//
// PORTED FROM (algorithm shape, NOT code): gateway-edit's
// `word-aligner-rcl@1.3.6` `helpers/alignmentHelpers.js`
// (`updateAlignmentsToTargetVerse` → unmerge → `findWordChanges` →
// renumber-occurrences → `addAlignmentsToVerseUSFM`/merge), confirmed against
// the pinned 1.3.6 source (re-read 2026-06-18). The SHAPE we adopt is:
//
//   1. UNMERGE the inline `\zaln` tree into a per-target-word pivot: each word
//      tagged with its full milestone ancestor chain (source key) + occurrence.
//   2. WORD-DIFF old vs new target words by surface text (LCS), so survivors are
//      matched per-word and only genuinely changed/new words lose alignment.
//   3. RE-MERGE survivors back onto the new target string, re-wrapping each in
//      its ORIGINAL milestone ancestry.
//
// What we deliberately did NOT port:
//   - `wordaligner.merge`/`unmerge` themselves. Those rebuild milestones as flat
//     `tag:"k"` nodes from a plain verse string and CANNOT preserve our nested
//     `tag:"zaln"` ancestry (lemma/morph/strong chains, compound H1>H2 nesting
//     that replace.test.mjs Cases 1/27/37/50 require). We keep the inline tree
//     and reuse each survivor's EXACT original milestone chain instead.
//   - The catch-all WHOLE-VERSE FLATTEN (`alignmentHelpers.js:933-940`:
//     `targetVerseUsfm = newTargetVerse` on null/throw). That is the exact
//     failure this refactor exists to kill. Instead we return null and the
//     caller falls back to the legacy tiers, then fails CLOSED (blocks the save)
//     — never flatten.
//
// The structural property this buys (that range-surgery lacks): a local edit
// degrades LOCALLY BY CONSTRUCTION. The diff is per-word, so a one-word spelling
// change can only ever drop that one word's alignment — it can never balloon a
// range across the verse (the NUM 24:19 / 1CH 4:21 flatten class).
//
// Keying shares NFC + (surface, occurrence) with web/src/lib/alignmentDelta.ts'
// analyzeAlignmentDelta (the #227 save guard), so a delta this engine considers
// "clean" is one the guard also considers clean — no surprise 409s.

import { nfc } from "./hebrew.ts";
import { isInFlowMarker, isCharacterWrapper } from "./usfm.ts";

export interface ReassemblyResult {
  verseObjects: unknown[];
  // Words present (by NFC surface + occurrence) in BOTH old and new that kept
  // their full source-key ancestry. false-positive impossible: survivors are
  // re-wrapped in their original chain, so they always keep their source.
  preservedAlignment: boolean;
}

// Word characters — kept byte-identical to replace.ts WORD_CHAR / WORD_RUN_RE so
// the two tokenize the same way (intra-word apostrophe/hyphen, grouping comma
// between digits, ZWJ/word-joiner). If they drift, reassembly and the diff tiers
// will disagree about word boundaries and the fallback will fire spuriously.
const WORD_CHAR = "[\\p{L}\\p{M}\\p{N}\\u200d\\u2060]";
const WORD_RUN_RE = new RegExp(
  `${WORD_CHAR}+(?:[-'’]${WORD_CHAR}+|(?<=\\p{N}),\\p{N}+)*`,
  "gu",
);

function tokenize(text: string): string[] {
  return [...text.matchAll(WORD_RUN_RE)].map((m) => m[0]);
}

// Split a string into the N+1 non-word gaps around N word runs. gap[0] leads the
// first word; gap[i] sits between word i-1 and word i; gap[N] trails the last.
// Mirrors replace.ts nonWordGaps.
function nonWordGaps(text: string): string[] {
  const gaps: string[] = [];
  let last = 0;
  for (const m of text.matchAll(WORD_RUN_RE)) {
    gaps.push(text.slice(last, m.index ?? 0));
    last = (m.index ?? 0) + m[0].length;
  }
  gaps.push(text.slice(last));
  return gaps;
}

// A single target word lifted out of the tree, carrying everything needed to
// re-wrap it identically: its `\w` node (cloned), and the chain of `\zaln`
// milestone nodes (outermost-first) it was nested under. The source key is the
// chain's strong|occurrence|occurrences|content signature — the SAME key
// analyzeAlignmentDelta uses (NFC), so survivor identity agrees with the guard.
interface PivotWord {
  node: Record<string, unknown>; // cloned \w node
  surface: string; // NFC surface, for diff keying
  occurrence: number; // 1-based, recomputed by NFC surface position
  // The \zaln ancestor chain (outermost → innermost), cloned WITHOUT children
  // so we can re-nest just this word. Empty = the word was unaligned (bare \w).
  chain: Record<string, unknown>[];
  sourceKey: string | null; // null when chain is empty
  // Stable id of the EXACT milestone-instance path this word sat under (one id
  // per ancestor node identity, not signature). Two words coalesce back into one
  // milestone only if their groupId matches — so two distinct same-signature
  // milestones (e.g. the two "father of" H0001 occ 1/2 in 1CH 4:21) never merge,
  // and neither do same-signature milestones that weren't literally the same node.
  groupId: string;
}

function isWordLeaf(node: unknown): node is Record<string, unknown> {
  const o = node as Record<string, unknown> | null;
  return !!o && o["type"] === "word" && o["tag"] === "w" && typeof o["text"] === "string";
}

function isZaln(node: unknown): node is Record<string, unknown> {
  const o = node as Record<string, unknown> | null;
  return !!o && o["tag"] === "zaln" && Array.isArray(o["children"]);
}

// Source signature of a single milestone — identical fields/order to
// alignmentDelta.ts sourcePart (NFC), so the keys are interchangeable.
function milestoneSig(node: Record<string, unknown>): string {
  const n = (v: unknown): string => nfc(String(v ?? ""));
  return [
    n(node["strong"]),
    n(node["occurrence"] ?? "1"),
    n(node["occurrences"] ?? "1"),
    n(node["content"]),
  ].join("|");
}

// Shallow clone of a milestone node WITHOUT its children (we re-nest one word at
// a time). Preserves every other field (strong, lemma, morph, occurrence,
// occurrences, content, endTag, type, tag) so the survivor's `\zaln-s` round-
// trips byte-identically through usfm-js.
function cloneMilestoneShell(node: Record<string, unknown>): Record<string, unknown> {
  const { children: _drop, ...rest } = node;
  return { ...rest };
}

// UNMERGE: walk the inline tree, returning the target words in document order,
// each with its full milestone ancestry + recomputed (NFC surface, occurrence).
// Returns null when the verse contains a structure reassembly can't faithfully
// rebuild — a CHARACTER WRAPPER (\qs Selah\qs*) holding content, or a marker
// carrying text/children — so the caller falls back rather than risk dropping it.
// (Inert line-break markers \q/\p/\b are fine: handled separately by the caller's
// marker reconcile; we ignore them here, as they carry no word.)
function unmerge(verseObjects: unknown[]): PivotWord[] | null {
  const words: PivotWord[] = [];
  let bail = false;
  const occBySurface = new Map<string, number>();
  let milestoneCounter = 0; // unique id per \zaln node INSTANCE

  const walk = (nodes: unknown[], chain: Record<string, unknown>[], groupPath: number[]): void => {
    for (const node of nodes) {
      if (bail) return;
      if (!node || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;

      // A character wrapper (\qs) holds aligned CONTENT but is not a \zaln
      // milestone — its nesting/round-trip is subtle (endTag, nextChar). Bail so
      // the legacy tiers (which special-case it) handle the whole verse.
      if (isCharacterWrapper(o)) {
        bail = true;
        return;
      }
      // An inert in-flow line-break marker (\q1/\p/\b/\ts*) is a zero-width
      // position anchor with no word payload — skip it (the caller re-places
      // markers via reconcileMarkers). A marker carrying text/children is NOT
      // inert (a quote parked on it, etc.); bail to be safe.
      if (isInFlowMarker(o)) {
        const hasText = typeof o["text"] === "string" && o["text"] !== "";
        const hasKids = Array.isArray(o["children"]) && (o["children"] as unknown[]).length > 0;
        if (hasText || hasKids) { bail = true; return; }
        continue;
      }

      if (isWordLeaf(o)) {
        const surface = nfc(String(o["text"]));
        const occ = (occBySurface.get(surface) ?? 0) + 1;
        occBySurface.set(surface, occ);
        words.push({
          node: { ...o },
          surface,
          occurrence: occ,
          chain: chain.map(cloneMilestoneShell),
          sourceKey: chain.length > 0 ? chain.map(milestoneSig).join(">") : null,
          groupId: groupPath.join("."),
        });
        continue;
      }

      if (isZaln(o)) {
        const id = milestoneCounter++;
        walk(o["children"] as unknown[], [...chain, o], [...groupPath, id]);
        continue;
      }

      // A plain text node carries punctuation/whitespace only — skip it (the gap
      // re-layout rebuilds all non-word text fresh from the new target string).
      if (o["type"] === "text") continue;

      // A childless, payload-free position anchor — the imported `\ts\*` chunk
      // milestone (tag `ts\*`, which isInFlowMarker doesn't match), an empty
      // `\b`/`\p`, etc. It carries no word, no text, no content and no children, so
      // it's safe to skip exactly as the inert in-flow markers above are; the
      // caller's reconcileMarkers / the diff tiers re-place such anchors. (Keeping
      // this skip is what lets NUM 24:19 — whose tail is a `ts\*` + `\m` — still
      // reassemble; bailing on it would regress that verse to the legacy flatten.)
      const hasChildren = Array.isArray(o["children"]) && (o["children"] as unknown[]).length > 0;
      const hasContent = typeof o["content"] === "string" && o["content"] !== "";
      const hasText = typeof o["text"] === "string" && o["text"] !== "";
      if (!hasChildren && !hasContent && !hasText) continue;

      // Anything else carries CONTENT reassembly can't faithfully rebuild — a
      // `\s1`/`\s2` section header (heading in `content`, not `children`, and
      // invisible to the editable-text self-check since sections are excluded from
      // extractEditableText), or any unknown wrapper/leaf bearing content/text/
      // children. BAIL so the caller falls back to the legacy diff tiers, which do
      // localized edits and leave such nodes untouched. Fail-closed for any future
      // node type we don't explicitly handle here.
      bail = true;
      return;
    }
  };

  walk(verseObjects, [], []);
  return bail ? null : words;
}

// LCS link: link[j] = index in oldWords that newWords[j] reuses, or -1 when new.
// Order-preserving, each old word claimed once, leftmost on ties. Identical
// algorithm to replace.ts lcsLink / alignmentDelta.ts lcsLinks — keys are NFC
// surface strings so all three agree on what "the same word" is.
function lcsLink(oldWords: string[], newWords: string[]): number[] {
  const n = oldWords.length;
  const m = newWords.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = oldWords[i] === newWords[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const link = new Array<number>(m).fill(-1);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldWords[i] === newWords[j]) { link[j] = i; i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
  }
  return link;
}

// Build the new verseObjects: re-lay punctuation gaps + survivors (wrapped in
// their original chain, adjacent same-chain survivors coalesced) + new bare
// words, in new-target order. Markers are NOT emitted here (caller reconciles
// them); we only place word + punctuation content.
function reassemble(
  pivot: PivotWord[],
  newWords: string[],
  newStripped: string,
): ReassemblyResult {
  const link = lcsLink(pivot.map((p) => p.surface), newWords.map((w) => nfc(w)));
  const gaps = nonWordGaps(newStripped); // newWords.length + 1 gaps

  // Per new word: the survivor PivotWord (link >=0) or null (new word).
  interface Plan {
    chain: Record<string, unknown>[];
    groupId: string; // milestone-INSTANCE id (coalesce only within the same one)
    node: Record<string, unknown>; // the \w node to emit (cloned survivor, or fresh)
    isNew: boolean;
  }
  const plan: Plan[] = newWords.map((surfaceRaw, j) => {
    const li = link[j];
    if (li >= 0) {
      const p = pivot[li];
      // Keep the ORIGINAL \w node's text (preserves any cantillation / exact
      // surface usfm-js stored) — link matched it by NFC surface, so the visible
      // text equals surfaceRaw up to NFC. Use the new token's raw text to be
      // safe against NFC display differences, but keep occurrence/occurrences off
      // the source (occurrence is recomputed on read server-side anyway).
      const node = { ...p.node, text: surfaceRaw };
      return { chain: p.chain, groupId: p.groupId, node, isNew: p.chain.length === 0 };
    }
    const node: Record<string, unknown> = {
      type: "word", tag: "w", text: surfaceRaw, occurrence: "1", occurrences: "1",
    };
    return { chain: [], groupId: "", node, isNew: true };
  });

  const out: unknown[] = [];
  const textNode = (text: string): unknown | null => (text ? { type: "text", text } : null);
  const push = (n: unknown | null) => { if (n) out.push(n); };

  let j = 0;
  while (j < plan.length) {
    // Coalesce a maximal run of adjacent survivors with the SAME non-empty chain
    // into one milestone group. Leading gap of the run is emitted OUTSIDE the
    // milestone; interior gaps live INSIDE (between the \w siblings).
    const cur = plan[j];
    push(textNode(gaps[j])); // gap before word j (outside any milestone)
    if (!cur.isNew && cur.chain.length > 0) {
      // gather the run
      let k = j;
      const members: number[] = [];
      while (
        k < plan.length &&
        !plan[k].isNew &&
        plan[k].chain.length > 0 &&
        plan[k].groupId === cur.groupId
      ) {
        members.push(k);
        k++;
      }
      // Build the milestone children: word, gap, word, gap, … (interior gaps).
      const innerChildren: unknown[] = [];
      for (let mi = 0; mi < members.length; mi++) {
        const idx = members[mi];
        innerChildren.push(plan[idx].node);
        if (mi < members.length - 1) {
          // interior gap between consecutive survivors of the same run
          push2(innerChildren, textNode(gaps[idx + 1]));
        }
      }
      out.push(wrapInChain2(innerChildren, cur.chain));
      j = k;
    } else {
      // bare/new word — emit just the \w node
      out.push(cur.node);
      j++;
    }
  }
  // Trailing gap after the last word.
  push(textNode(gaps[plan.length]));

  // preservedAlignment: at least one survivor kept a (non-empty) source chain.
  const keptSource = plan.some((p) => !p.isNew && p.chain.length > 0);
  return { verseObjects: out, preservedAlignment: keptSource };
}

function push2(arr: unknown[], n: unknown | null) { if (n) arr.push(n); }

// wrapInChain for a milestone group with MULTIPLE word children (a coalesced
// run). chain is outermost→innermost; the innermost wraps `children`.
function wrapInChain2(children: unknown[], chain: Record<string, unknown>[]): unknown {
  let inner: unknown[] = children;
  for (let k = chain.length - 1; k >= 0; k--) {
    inner = [{ ...cloneMilestoneShell(chain[k]), children: inner }];
  }
  return inner[0];
}

// Rebuild the raw concatenated text of a verseObjects tree (markers carry none).
function rebuildRaw(nodes: unknown[]): string {
  const parts: string[] = [];
  const walk = (ns: unknown[]) => {
    for (const n of ns ?? []) {
      const o = n as Record<string, unknown> | null;
      if (!o) continue;
      if (typeof o["text"] === "string") parts.push(o["text"] as string);
      if (Array.isArray(o["children"])) walk(o["children"] as unknown[]);
    }
  };
  walk(nodes);
  return parts.join("");
}

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// Collect the multiset of STRUCTURAL nodes in a tree — every node that CARRIES
// CONTENT and is NOT a word leaf, a `\zaln` milestone, a plain `type:"text"`
// node, an in-flow marker, or a payload-free position anchor (an `\ts\*`/empty
// `\b` — no content/text/children; reassembly legitimately strips these, and the
// caller's reconcileMarkers re-places them). In practice this is section headers
// (`\s1`/`\s2`) and any node type we don't explicitly handle that bears content.
// These carry content (e.g. a section's heading lives in `content`, not in the
// editable target string), so the text self-check can't see them — this lets us
// assert they round-trip. Keyed by type+tag+content/text so a missing or altered
// structural node is detectable. We do NOT recurse into `\zaln` children (their
// words/text are covered by the text self-check); we walk other wrappers'
// children so a structural node nested anywhere is still counted.
function structuralNodeSignatures(nodes: unknown[]): Map<string, number> {
  const sigs = new Map<string, number>();
  const walk = (ns: unknown[]) => {
    for (const n of ns ?? []) {
      const o = n as Record<string, unknown> | null;
      if (!o || typeof o !== "object") continue;
      if (isWordLeaf(o) || o["type"] === "text") continue;
      if (isInFlowMarker(o)) continue;
      if (isZaln(o)) {
        // A milestone is structurally a word-wrapper; its words/text are covered by
        // the text self-check. Don't count the milestone itself, but DO descend in
        // case a structural node was (improperly) nested inside.
        walk(o["children"] as unknown[]);
        continue;
      }
      // A payload-free position anchor (`\ts\*`, empty `\b`/`\p`) carries no
      // content reassembly could lose — and reassembly strips it deliberately for
      // reconcileMarkers to re-place. Don't count it (counting it would spuriously
      // fail the completeness check, since the reassembled output omits it). Mirror
      // the unmerge skip exactly.
      const hasChildrenAnchor = Array.isArray(o["children"]) && (o["children"] as unknown[]).length > 0;
      const hasContentAnchor = typeof o["content"] === "string" && o["content"] !== "";
      const hasTextAnchor = typeof o["text"] === "string" && o["text"] !== "";
      if (!hasChildrenAnchor && !hasContentAnchor && !hasTextAnchor) continue;
      // A structural node (section header, character wrapper, or any unknown leaf/
      // wrapper) that bears content. Record it; key on the fields that carry its
      // identity + content.
      const sig = JSON.stringify([
        o["type"] ?? "",
        o["tag"] ?? "",
        o["content"] ?? "",
        o["text"] ?? "",
      ]);
      sigs.set(sig, (sigs.get(sig) ?? 0) + 1);
      if (Array.isArray(o["children"])) walk(o["children"] as unknown[]);
    }
  };
  walk(nodes);
  return sigs;
}

// Count the disjoint CHANGE REGIONS between two word-token sequences (NFC),
// using the LCS to find the surviving anchors. A region is a maximal run of
// non-survivor positions (inserted new words and/or deleted old words) flanked by
// survivors or the verse edges. Two separate edits at opposite ends of the verse
// (NUM 24:19: `he`→`{one}` near the start, `a`→`{the}` near the end) yield 2
// regions; a single contiguous edit yields 1. The single-range diff tiers handle
// 1 region cleanly; reassembly's value is the 2+ case it can't.
function countChangeRegions(oldWords: string[], newWords: string[]): number {
  const link = lcsLink(oldWords, newWords); // link[j in new] = matched old index
  // Walk the NEW sequence; a survivor is link[j] >= 0. Also account for OLD
  // words that were deleted between two survivors — they add to the SAME region
  // as adjacent new-word changes. Track via matched old indices advancing.
  let regions = 0;
  let inRegion = false;
  let prevOld = -1;
  for (let j = 0; j < newWords.length; j++) {
    const oi = link[j];
    if (oi >= 0) {
      // A survivor. If old words were skipped since the last survivor (deletions)
      // and we weren't already in a region, that gap is itself a change region.
      if (!inRegion && oi > prevOld + 1) regions++;
      inRegion = false;
      prevOld = oi;
    } else {
      // A new/changed word — part of a change region.
      if (!inRegion) { regions++; inRegion = true; }
    }
  }
  // Trailing deletions after the last survivor (old words beyond prevOld) form
  // one more region if we didn't already close one on a new word.
  if (!inRegion && prevOld + 1 < oldWords.length) regions++;
  return regions;
}

// PRIMARY ENGINE ENTRY POINT.
//
// Given the current inline verseObjects (markers already lifted by the caller)
// and the marker-stripped, whitespace-normalized NEW target text, reassemble the
// alignment so that:
//   - every surviving target word (same NFC surface + occurrence position via
//     LCS) keeps its EXACT original milestone ancestry;
//   - genuinely new/changed words are bare (unaligned), which is correct;
//   - new punctuation/whitespace is re-laid from the new text.
//
// Returns null (→ caller falls back to legacy tiers, then fails closed) when:
//   - the verse has a structure unmerge can't faithfully rebuild (\qs wrapper,
//     text/child-bearing marker, unknown wrapper);
//   - there are no surviving words to anchor (pure insertion/replacement) — the
//     caller's tiers handle that with less risk of dropping unrelated alignment;
//   - the reconstructed raw text doesn't match the requested text exactly
//     (whitespace-collapse aside) — a self-check that guarantees NO text loss,
//     the gateway-edit landmine we refuse to ship.
export function reassembleAlignment(
  verseObjects: unknown[],
  newStripped: string,
): ReassemblyResult | null {
  if (!Array.isArray(verseObjects)) return null;
  const pivot = unmerge(verseObjects);
  if (!pivot) return null;

  // GATE 1 — clean whole-word storage. The OLD verse's \w leaves must tokenize
  // 1:1 with the OLD raw word tokens (each \w leaf IS a complete single token).
  // When they don't, a SPLIT UNIT is present — a possessive (Yahweh’s = \w
  // "Yahweh" + "’" + \w "s") or hyphenated name stores ONE WORD_RUN_RE token as
  // several \w leaves. Our per-leaf pivot would mis-key those against the
  // contiguous new tokens; smartRebuildRange forms word UNITS and handles them
  // (Case 40). Defer. (No-op for the clean case — every aligned word a whole
  // token — so reassembly proceeds there.)
  const oldRaw = rebuildRaw(verseObjects);
  const oldTokens = tokenize(oldRaw);
  if (pivot.length !== oldTokens.length) return null;
  for (let i = 0; i < pivot.length; i++) {
    if (pivot[i].surface !== nfc(oldTokens[i])) return null;
  }

  const newWords = tokenize(newStripped);
  if (newWords.length === 0) return null;

  // GATE 2 — only fire when the edit is genuinely MULTI-REGION (the class that
  // balloons the single-range diff and flattens untouched neighbours, e.g. NUM
  // 24:19's start word edit + end punctuation). A SINGLE contiguous change region
  // is exactly what the proven diff tiers handle best — including the in-word
  // edits reassembly would regress: a space/bracket typed into an aligned word
  // ("beta" → "be ta") splits it into NEW surface forms; the localized rewrite
  // keeps the split fragments aligned inside the original milestone (Cases
  // 25/26/27/50), whereas reassembly drops both fragments bare. So: count the
  // disjoint word-token change regions between old and new; defer to the tiers
  // unless there are 2+. Equal-length common-prefix/suffix word matching gives a
  // cheap region count.
  if (countChangeRegions(oldTokens.map((t) => nfc(t)), newWords.map((w) => nfc(w))) < 2) {
    return null;
  }

  // Require at least one survivor — otherwise this is a pure insertion / total
  // replacement with no anchor, which the diff tiers handle (and where there is
  // no alignment to preserve anyway).
  const oldSurfaces = pivot.map((p) => p.surface);
  const newSurfaces = newWords.map((w) => nfc(w));
  const link = lcsLink(oldSurfaces, newSurfaces);
  if (!link.some((x) => x >= 0)) return null;
  // Require at least one survivor that WAS aligned — if nothing aligned survives,
  // there's nothing for this engine to protect and the tiers are equivalent.
  if (!link.some((x) => x >= 0 && pivot[x].sourceKey !== null)) {
    // Still safe to proceed (it would just reproduce bare words), but defer to
    // the tiers which also handle marker-only / punctuation-only shapes.
    // Only proceed if at least one ALIGNED word survives.
    return null;
  }

  const result = reassemble(pivot, newWords, newStripped);

  // Self-check: rebuilt raw text must equal the requested text (whitespace
  // collapsed). Any divergence → bail, never persist a tree that lost/gained
  // characters. This replaces gateway-edit's flatten-on-failure with fail-open
  // to the next tier (which then fails CLOSED if it can't preserve either).
  const rebuilt = normalizeWs(rebuildRaw(result.verseObjects));
  if (rebuilt !== normalizeWs(newStripped)) return null;

  // Node-completeness self-check (defense in depth). The text self-check above
  // only covers WORD + punctuation/whitespace content; STRUCTURAL nodes (section
  // headers, and any node type we don't explicitly handle) carry content the
  // editable string never sees, so a dropped section would slip past it. Assert
  // every structural node present in the INPUT is present, unaltered, in the
  // OUTPUT. Any missing/changed one → bail to the legacy tiers (which do localized
  // edits and preserve such nodes). With the unmerge bail above this is already
  // unreachable for sections today; it makes the engine FAIL-CLOSED for any future
  // node type too, not just the ones we know about.
  const inSigs = structuralNodeSignatures(verseObjects);
  const outSigs = structuralNodeSignatures(result.verseObjects);
  for (const [sig, count] of inSigs) {
    if ((outSigs.get(sig) ?? 0) < count) return null;
  }

  return result;
}
