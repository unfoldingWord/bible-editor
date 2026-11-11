// Curl straight quotes in a verse tree on save (#1273).
//
// Mirror of api/src/importParsers.ts curlifyVerseObjects (with its helpers
// isOpeningQuoteContext / curlifyChar / curlifyTextWithContext) — keep behavior
// in sync. Duplicated rather than imported for the same cross-bundle reason as
// the other web/src/lib mirrors (alignmentDelta.ts, canonizeQuote.ts).
//
// Why it exists: curlyQuotes.ts curls a quote as it is typed, but only for a
// single-character `insertText`. Multi-character inserts (predictive text,
// autocorrect, dictation, extensions), IME composition, drag-and-drop and the
// Copy T4T to UST button all reach saveVerseDraft with straight quotes, and
// those were saved as typed.
//
// Why AFTER smartEditVerse and on the tree, not on the typed string: the edit
// engine reuses an untouched aligned word only when its surface text matches
// exactly. Curling the typed string first would turn an untouched `baby's`
// into `baby’s`, the engine would treat it as an edited word and drop its
// alignment, and the save guard would not notice. Curling the result tree
// changes only `.text` strings: no node is added, removed or moved, and the
// tokenizer treats ' and ’ alike, so word counts and alignment are unchanged.

const CURLY_LDQUO = "“";
const CURLY_RDQUO = "”";
const CURLY_LSQUO = "‘";
const CURLY_RSQUO = "’";

function isOpeningQuoteContext(prev: string | undefined, prevPrev?: string | undefined): boolean {
  if (!prev) return true;
  if (/\s/.test(prev)) return true;
  // The literal two-character `\n` escape (TSV prose convention) opens.
  // Verse trees never carry it; kept so the mirror stays exact.
  if (prev === "n" && prevPrev === "\\") return true;
  return /[(\[{<\-–—/“‘]/.test(prev);
}

// Two of the same straight quote back to back alternate (`""` → “”), since the
// context rule alone would open twice. Otherwise the context rule decides.
function curlifyChar(
  ch: '"' | "'",
  prevRaw: string | undefined,
  prevCurled: string | undefined,
  prevCurled2?: string | undefined,
): string {
  if (prevRaw === ch) {
    if (ch === '"') return prevCurled === CURLY_LDQUO ? CURLY_RDQUO : CURLY_LDQUO;
    return prevCurled === CURLY_LSQUO ? CURLY_RSQUO : CURLY_LSQUO;
  }
  if (ch === '"') return isOpeningQuoteContext(prevCurled, prevCurled2) ? CURLY_LDQUO : CURLY_RDQUO;
  return isOpeningQuoteContext(prevCurled, prevCurled2) ? CURLY_LSQUO : CURLY_RSQUO;
}

function curlifyTextWithContext(
  text: string,
  prevCurled: string | undefined,
  prevRaw: string | undefined,
): { text: string; changed: boolean } {
  let out = "";
  let changed = false;
  let curled = prevCurled;
  let curled2: string | undefined = undefined;
  let raw = prevRaw;
  for (const ch of text) {
    if (ch === '"' || ch === "'") {
      const curly = curlifyChar(ch, raw, curled, curled2);
      out += curly;
      if (curly !== ch) changed = true;
      curled2 = curled;
      curled = curly;
    } else {
      out += ch;
      curled2 = curled;
      curled = ch;
    }
    raw = ch;
  }
  return { text: out, changed };
}

// Mutates in place. Walks every node's own `.text` in document order, except
// `\zaln-s` milestones (source-owned attributes, never touched); milestone
// children (the aligned target words) are walked normally.
//
// One difference from the API copy: a `\p`/`\q#` line marker starts a new
// line, so a quote right after it opens even when the text before the marker
// ends in a letter or comma ("said,\q1 'Turn" → ‘Turn, not ’Turn).
function curlifyVerseObjectsInPlace(verseObjects: unknown[]): void {
  let prevCurled: string | undefined;
  let prevRaw: string | undefined;
  const walk = (nodes: unknown[]): void => {
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const o = node as Record<string, unknown>;
      if (o["type"] === "paragraph" || o["type"] === "quote") {
        prevCurled = "\n";
        prevRaw = "\n";
      }
      const isSourceMilestone = o["type"] === "milestone" && o["tag"] === "zaln";
      const text = o["text"];
      if (!isSourceMilestone && typeof text === "string" && text.length > 0) {
        if (/['"]/.test(text)) {
          const result = curlifyTextWithContext(text, prevCurled, prevRaw);
          if (result.changed) o["text"] = result.text;
          prevCurled = result.text[result.text.length - 1];
        } else {
          prevCurled = text[text.length - 1];
        }
        prevRaw = text[text.length - 1];
      }
      if (Array.isArray(o["children"])) walk(o["children"] as unknown[]);
    }
  };
  walk(verseObjects);
}

function hasStraightQuoteText(nodes: unknown[]): boolean {
  for (const node of nodes) {
    if (!node || typeof node !== "object") continue;
    const o = node as Record<string, unknown>;
    const isSourceMilestone = o["type"] === "milestone" && o["tag"] === "zaln";
    if (!isSourceMilestone && typeof o["text"] === "string" && /['"]/.test(o["text"])) return true;
    if (Array.isArray(o["children"]) && hasStraightQuoteText(o["children"] as unknown[])) return true;
  }
  return false;
}

const STRAIGHT_FORM: Record<string, string> = { "‘": "'", "’": "'", "“": '"', "”": '"' };

function sameOrStraightened(baseCh: string, typedCh: string): boolean {
  return baseCh === typedCh || STRAIGHT_FORM[baseCh] === typedCh;
}

// Where the typed text has a straight quote at a spot the saved verse already
// has curled, use the saved curly form, so the edit engine sees no change
// there. Only the unchanged lead and tail are reconciled (the same common
// prefix/suffix the engine diffs on); the edited middle is kept as typed and
// curled after the engine runs.
//
// Needed because the save curls every straight quote anyway, so ' for ’ is
// not a real edit, but the engine diffs characters: a stored `Yahweh’s` that
// was retyped as `Yahweh's` (seen live on ZEC 6:15 UST, with a second edit at
// the far end of the verse) made the engine rewrite everything between the
// two spots and silently drop the alignment of the words there. The same
// applies to an editor that still shows a ' the save has already curled.
// Only straight-for-curly counts as unchanged: a deliberate ’ → ‘ change is
// still a change.
export function adoptBaseQuotes(base: string, typed: string): string {
  if (!/['"]/.test(typed)) return typed;
  const n = Math.min(base.length, typed.length);
  let p = 0;
  while (p < n && sameOrStraightened(base[p], typed[p])) p++;
  let s = 0;
  while (s < n - p && sameOrStraightened(base[base.length - 1 - s], typed[typed.length - 1 - s])) s++;
  return base.slice(0, p) + typed.slice(p, typed.length - s) + base.slice(base.length - s);
}

// Returns verse content with every straight quote in its text curled. Never
// mutates `content`: the engine's result shares untouched nodes with the
// pinned base and the chapter cache, so a curled copy is built instead. Returns
// `content` itself (same reference) when there is nothing to curl.
export function curlifyVerseContent<T>(content: T): T {
  const vo = (content as { verseObjects?: unknown } | null)?.verseObjects;
  if (!Array.isArray(vo) || !hasStraightQuoteText(vo)) return content;
  const copy = structuredClone(content) as T & { verseObjects: unknown[] };
  curlifyVerseObjectsInPlace(copy.verseObjects);
  return copy;
}
