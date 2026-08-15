// Pure core of the number-split repair (GitHub issue #452).
//
// Extracted from scripts/repair-number-split-verses.mjs so it can be tested
// without a production dump: everything here is a pure function over a
// usfm-js verse tree. The CLI script owns argument parsing, D1 dump loading,
// SQL emission and reporting; this module owns the transform and every guard
// that decides whether a verse may be touched at all.
//
// Tests: scripts/lib/numberSplit.test.mjs (`npm run test:scripts`).
//
// ── THE DEFECT ─────────────────────────────────────────────────────────────
//   Verses read "1, 000" / "22, 600" — a stray space inside the thousands
//   separator. In the stored tree the number straddles two aligned `\w` word
//   tokens with the separator in a plain text node between them:
//
//     {tag:"w", text:"24"}  {type:"text", text:", "}  {tag:"w", text:"000"}
//
//   The repair deletes exactly one character — the space — from the node that
//   owns it, and touches nothing else.

// ── shared dump loading ────────────────────────────────────────────────────

// Rows out of a `wrangler d1 execute --json` dump. Shared by the generator and
// the independent verifier so the two cannot disagree about what a dump is.
//
// Wrangler prefixes its output with human-readable banner lines that can
// themselves contain brackets (`▲ [WARNING] Processing wrangler.toml
// configuration:`), so "the first [ in the file" is NOT a safe start marker —
// it lands inside the banner and JSON.parse throws. Drop whole leading LINES
// until one actually begins the JSON document.
export function extractJsonRows(text, whence = "<input>") {
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trimStart();
    if (t.startsWith("[") || t.startsWith("{")) { start = i; break; }
  }
  if (start < 0) throw new Error(`no JSON document found in ${whence}`);
  const parsed = JSON.parse(lines.slice(start).join("\n"));
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  if (arr.length && arr[0] && Array.isArray(arr[0].results)) return arr.flatMap((x) => x.results || []);
  return arr;
}

// ── patterns ───────────────────────────────────────────────────────────────

// REPAIRABLE: a digit, then a comma, then EXACTLY ONE PLAIN SPACE (U+0020),
// then exactly three digits not followed by a fourth. This is the only shape
// this module will rewrite.
//
// Applied ONE SITE AT A TIME and re-derived after each deletion, because
// consecutive groups overlap: in "1, 100, 000" a single global pass consumes
// the "100" that the second site needs as its left digit and would leave
// "1,100, 000" half-repaired. Iterating to a fixed point handles chained
// groups ("1,100,000", "200,000,000") correctly.
export const DEFECT_RE = /(\d), (\d{3})(?!\d)/;

// DETECTABLE: the same shape but with ANY run of whitespace as the separator —
// non-breaking space, narrow no-break space, tab, newline, several spaces.
//
// Detection and repair are deliberately different widths. `plain_text` is
// whitespace-collapsed at ingest, so a tree holding "3, 000" (NBSP) shows
// up as "3, 000" in the column the dump SELECTs on. Matching detection to the
// narrow repair pattern made such a verse report "tree already repaired" —
// a false all-clear on a genuinely broken verse. Now the wide pattern decides
// "this verse has a defect" and the narrow one decides "and I know how to fix
// it"; anything detected but not repairable is REFUSED for a human to look at.
// JS's whitespace class already covers U+00A0 (NBSP), U+2000-U+200A (including
// the figure space), U+202F (narrow NBSP), U+205F, U+3000 and the ASCII set,
// so one whitespace-plus is the whole wide class. The `+` also catches a
// doubled plain space, which DEFECT_RE deliberately will not repair.
export const DETECT_RE = new RegExp(String.raw`(\d),\s+(\d{3})(?!\d)`);

const reAll = (re) => new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");

// ── tree model ─────────────────────────────────────────────────────────────

// Every node in document order, with the half-open [start, end) range of the
// raw character stream it contributes and a reference to its PARENT. Container
// nodes (milestones) and marker nodes contribute nothing and are recorded
// zero-width at their position, so a structural break between two digits is
// detectable rather than invisible.
export function flatten(verseObjects) {
  const flat = [];
  let offset = 0;
  const walk = (nodes, parent) => {
    for (const n of nodes || []) {
      if (!n || typeof n !== "object") continue;
      const text = typeof n.text === "string" ? n.text : "";
      flat.push({ node: n, parent, start: offset, end: offset + text.length });
      offset += text.length;
      if (Array.isArray(n.children)) walk(n.children, n);
    }
  };
  walk(verseObjects, null);
  const raw = flat.map((f) => (typeof f.node.text === "string" ? f.node.text : "")).join("");
  return { flat, raw };
}

export function countZaln(verseObjects) {
  let c = 0;
  const walk = (ns) => {
    for (const n of ns || []) {
      if (!n || typeof n !== "object") continue;
      if (n.type === "milestone" && n.tag === "zaln") c++;
      if (Array.isArray(n.children)) walk(n.children);
    }
  };
  walk(verseObjects);
  return c;
}

export function wordSurfaces(verseObjects) {
  const out = [];
  const walk = (ns) => {
    for (const n of ns || []) {
      if (!n || typeof n !== "object") continue;
      if (n.type === "word" && n.tag === "w") out.push(String(n.text ?? ""));
      if (Array.isArray(n.children)) walk(n.children);
    }
  };
  walk(verseObjects);
  return out;
}

export function countNodes(verseObjects) {
  let c = 0;
  const walk = (ns) => {
    for (const n of ns || []) {
      if (!n || typeof n !== "object") continue;
      c++;
      if (Array.isArray(n.children)) walk(n.children);
    }
  };
  walk(verseObjects);
  return c;
}

// Whitespace-insensitive structural signature: every node, in document order,
// with every attribute it carries, and its text stripped of ALL whitespace.
// The only edit this module makes is deleting a space, so this signature MUST
// be identical before and after. Any milestone split, node reorder, word merge,
// marker move or attribute change shows up here as an inequality.
export function signature(verseObjects) {
  const parts = [];
  const walk = (ns) => {
    for (const n of ns || []) {
      if (!n || typeof n !== "object") continue;
      const attrs = {};
      for (const k of Object.keys(n).sort()) {
        if (k === "text" || k === "children") continue;
        attrs[k] = n[k];
      }
      parts.push(JSON.stringify(attrs) + "|" + String(n.text ?? "").replace(/\s+/g, ""));
      if (Array.isArray(n.children)) {
        parts.push("(");
        walk(n.children);
        parts.push(")");
      }
    }
  };
  walk(verseObjects);
  return parts.join("");
}

// ── the transform ──────────────────────────────────────────────────────────

const isTextNode = (n) => n && (n.type === "text" || n.tag === "w");

// Repair every defect site in `verseObjects` IN PLACE (caller passes a clone).
// Returns { sites, error }. `sites` records the raw offset of each deleted
// space in the coordinate system of the ORIGINAL raw text, so the caller can
// verify the final raw text character for character.
export function repairTree(verseObjects) {
  const sites = [];
  // Offsets shift left by one for every earlier deletion; track the running
  // shift so recorded offsets stay in ORIGINAL coordinates.
  //
  // This is only sound because matches are found strictly left to right and a
  // deletion can never create a NEW match to the LEFT of the one just fixed:
  // a match needs `digit , space` at its head, and the three positions before
  // the join point already hold a digit, a comma and a digit. So every earlier
  // deletion was at a smaller original offset, and `original = current + shift`.
  let shift = 0;
  for (let pass = 0; ; pass++) {
    if (pass > 64) return { sites, error: "did not reach a fixed point in 64 passes" };
    const { flat, raw } = flatten(verseObjects);
    const m = DEFECT_RE.exec(raw);
    if (!m) break;

    const iLeftDigit = m.index;
    const iSpace = m.index + 2;
    const iRightDigit = m.index + 3;

    const at = (i) => flat.findIndex((f) => i >= f.start && i < f.end);
    const leftIdx = at(iLeftDigit);
    const spaceIdx = at(iSpace);
    const rightIdx = at(iRightDigit);
    if (leftIdx < 0 || spaceIdx < 0 || rightIdx < 0) {
      return { sites, error: `could not locate the defect site at raw offset ${iSpace}` };
    }

    const spaceNode = flat[spaceIdx].node;
    const localIdx = iSpace - flat[spaceIdx].start;
    if (spaceNode.text[localIdx] !== " ") {
      return { sites, error: `character at raw offset ${iSpace} is not a plain space` };
    }
    if (spaceNode.tag === "w") {
      return { sites, error: `the space sits inside a \\w word token ("${spaceNode.text}") — refusing` };
    }

    // GUARD A — every node the site touches must be ordinary text or a `\w`.
    //
    // usfm-js parks the text that FOLLOWS a marker on the MARKER node itself
    // (`{tag:"q1", type:"paragraph", text:"000 men."}` — see liftMarkerText in
    // web/src/lib/usfm.ts). Such a node is not zero-width, so a guard that only
    // rejected zero-width nodes let it through and the "space" being deleted
    // was really the space before a `\q1` — the documented marker-fusion
    // hazard, and the number stays split across the poetry line anyway.
    for (let k = leftIdx; k <= rightIdx; k++) {
      const n = flat[k].node;
      if (!isTextNode(n)) {
        return {
          sites,
          error:
            `a non-text node (${JSON.stringify({ tag: n.tag, type: n.type })}) is part of the` +
            ` defect site at raw offset ${iSpace} — refusing`,
        };
      }
    }

    // GUARD B — the digits either side of the join must share a PARENT.
    //
    // Guard A walks the flat document order, which cannot see a milestone
    // CLOSING between the two halves: in
    //   [ zaln [ w"24", text", " ], w"000" ]
    // every node the site touches is text-or-\w and none is zero-width, yet
    // "24" is inside the alignment span and "000" is outside it. Joining them
    // bridges an alignment boundary — the left digits stay aligned to the
    // Hebrew and the right digits do not, which is precisely the corruption
    // this script exists to avoid. Same parent means same alignment context.
    const parentOf = (i) => flat[i].parent;
    if (parentOf(leftIdx) !== parentOf(rightIdx) || parentOf(spaceIdx) !== parentOf(leftIdx)) {
      return {
        sites,
        error:
          `the digits at raw offset ${iSpace} are not siblings — an alignment milestone opens or` +
          ` closes between them, so joining would bridge an alignment boundary — refusing`,
      };
    }

    spaceNode.text = spaceNode.text.slice(0, localIdx) + spaceNode.text.slice(localIdx + 1);

    // Report the WHOLE number, not just the two digits the regex captured:
    // "36,000", not "6,000". Read it back out of the freshly repaired raw text
    // by walking outward over digits and commas from the join point.
    const healedRaw = flatten(verseObjects).raw;
    const isNumChar = (c) => c != null && /[\d,]/.test(c);
    let lo = iSpace - 1;
    while (lo > 0 && isNumChar(healedRaw[lo - 1])) lo--;
    let hi = iSpace;
    while (hi < healedRaw.length && isNumChar(healedRaw[hi])) hi++;

    sites.push({
      originalOffset: iSpace + shift,
      joined: healedRaw.slice(lo, hi).replace(/^,+|,+$/g, ""),
      was: raw.slice(Math.max(0, m.index - 24), m.index + m[0].length + 16),
    });
    shift += 1;
  }
  return { sites, error: null };
}

// The same join applied to a flat string (used for plain_text).
export function joinString(s) {
  let out = s;
  for (let i = 0; i < 64; i++) {
    const next = out.replace(DEFECT_RE, (_all, a, b) => a + "," + b);
    if (next === out) return out;
    out = next;
  }
  return out;
}

// ── whole-verse repair + verification ──────────────────────────────────────

// Repair one verse and verify the result completely. Pure: takes and returns
// strings/objects, touches nothing outside itself.
//
// Returns one of:
//   { status: "clean" }                       — no defect in the tree
//   { status: "plain_text_only", newPlain }   — tree clean, plain_text stale
//   { status: "refused", why }                — a guard fired; never write this
//   { status: "repaired", newContentJson, newPlain, sites, stats, plainTextDrift }
export function repairVerse(contentJson, plainText) {
  let original;
  try {
    original = JSON.parse(contentJson);
  } catch (e) {
    return { status: "refused", why: `content_json does not parse: ${e.message}` };
  }
  if (!Array.isArray(original.verseObjects)) {
    return { status: "refused", why: "content_json has no verseObjects array" };
  }

  const beforeFlat = flatten(original.verseObjects);
  const treeHasDefect = DETECT_RE.test(beforeFlat.raw);

  if (!treeHasDefect) {
    // The tree is clean. But the dump is SELECTed on a `plain_text` GLOB, and
    // the two can disagree: a row whose tree was already repaired while its
    // denormalized plain_text still holds "1, 000" will match the GLOB on
    // every future dump forever. Call that out as its own category so the scan
    // converges in the operator's head instead of silently never converging.
    if (plainText != null && DETECT_RE.test(plainText)) {
      return { status: "plain_text_only", newPlain: joinString(plainText) };
    }
    return { status: "clean" };
  }

  const beforeStats = {
    zaln: countZaln(original.verseObjects),
    words: wordSurfaces(original.verseObjects),
    nodes: countNodes(original.verseObjects),
    signature: signature(original.verseObjects),
  };

  const workingContent = JSON.parse(contentJson); // independent clone
  const { sites, error } = repairTree(workingContent.verseObjects);
  if (error) return { status: "refused", why: error };
  if (!sites.length) {
    // DETECT_RE matched but DEFECT_RE did not: the separator is whitespace,
    // but not a single plain space (NBSP, tab, newline, a double space). The
    // right fix depends on which — refuse and let a human look.
    const m = reAll(DETECT_RE).exec(beforeFlat.raw);
    const sep = m ? JSON.stringify(m[0]) : "?";
    return {
      status: "refused",
      why: `separator is whitespace but not a single plain space (${sep}) — refusing, needs a manual look`,
    };
  }

  const newContentJson = JSON.stringify(workingContent);
  let roundTripped;
  try {
    roundTripped = JSON.parse(newContentJson);
  } catch (e) {
    return { status: "refused", why: `repaired content_json does not round-trip: ${e.message}` };
  }

  const afterFlat = flatten(roundTripped.verseObjects);
  const afterStats = {
    zaln: countZaln(roundTripped.verseObjects),
    words: wordSurfaces(roundTripped.verseObjects),
    nodes: countNodes(roundTripped.verseObjects),
    signature: signature(roundTripped.verseObjects),
  };

  const problems = [];
  if (afterStats.zaln !== beforeStats.zaln)
    problems.push(`zaln milestone count changed ${beforeStats.zaln} → ${afterStats.zaln}`);
  if (afterStats.words.length !== beforeStats.words.length)
    problems.push(`\\w count changed ${beforeStats.words.length} → ${afterStats.words.length}`);
  if (afterStats.words.join(" ") !== beforeStats.words.join(" "))
    problems.push("the ordered list of \\w surface forms changed");
  if (afterStats.nodes !== beforeStats.nodes)
    problems.push(`node count changed ${beforeStats.nodes} → ${afterStats.nodes}`);
  if (afterStats.signature !== beforeStats.signature)
    problems.push("whitespace-insensitive structural signature changed — the tree moved");

  // Character-exact: the new raw text must be the old raw text with exactly
  // the recorded space offsets removed, and nothing else.
  //
  // split("") and NOT [...raw]: every offset here comes from String#length and
  // String#slice, which count UTF-16 CODE UNITS, while the spread iterator
  // yields CODE POINTS. One astral character before a site would desynchronise
  // the two and drop the wrong character.
  const dropped = new Set(sites.map((s) => s.originalOffset));
  const expectedRaw = beforeFlat.raw.split("").filter((_c, i) => !dropped.has(i)).join("");
  if (afterFlat.raw !== expectedRaw)
    problems.push("raw text is not the original with exactly the recorded spaces removed");
  if (DETECT_RE.test(afterFlat.raw)) problems.push("a defect site remains after the repair");

  if (problems.length) return { status: "refused", why: problems.join("; ") };

  if (plainText == null) {
    return {
      status: "refused",
      why: "plain_text is NULL — refusing rather than inventing a value for it",
    };
  }
  const newPlain = joinString(plainText);
  // joinString gives up after 64 iterations rather than looping forever. That
  // bail-out must not become a silent half-repair.
  if (DETECT_RE.test(newPlain)) {
    return { status: "refused", why: "plain_text still contains a split number after the join" };
  }

  return {
    status: "repaired",
    newContentJson,
    newPlain,
    sites,
    stats: { zaln: beforeStats.zaln, words: beforeStats.words.length, nodes: beforeStats.nodes },
    plainTextDrift: plainText !== beforeFlat.raw.replace(/\s+/g, " ").trim(),
  };
}
