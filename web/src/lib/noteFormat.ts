// Plain-text markdown formatting operations for the note textarea. Each takes
// the current value + selection and returns the new value + selection, so the
// caller (NoteCard's toolbar / key handlers) never has to count spaces.
//
// Conventions match what the preview renders and what the TSV stores: ordered
// items are `N. `, bullets are `* ` (existing `-`/`+` bullets are recognised
// too), and one nesting level is four spaces.

export const INDENT = "    ";

export type FormatResult = { value: string; selStart: number; selEnd: number };

const ORDERED_RE = /^( *)(\d+)\. (.*)$/;
const BULLET_RE = /^( *)([-*+]) (.*)$/;

// Existing intros were often written with two-space top-level items and
// four-space children. CommonMark needs a child indented past the parent's
// marker (three or more columns under `1. `), so those children render as
// run-on text instead of a nested list. Snap every list line to whole levels
// (0–2 spaces is the top level, 3–6 is one deep, and so on), and never let an
// item sit more than one level below the item before it — a stray 7-space
// line under a top-level item is its child, not a grandchild with no parent
// (which Markdown would render as a code block).
function snappedLevel(indent: number): number {
  return Math.floor((indent + 1) / INDENT.length);
}

// Normalises every list line — indentation snapped to four-space levels and
// ordered items renumbered 1. 2. 3. per level, restarting a level's count when
// a shallower line ends the list. Never adds or removes lines.
export function normalizeLists(text: string): string {
  // Open list levels (0, 1, 2…) and the running count of ordered items at each.
  const open = new Set<number>();
  const counters = new Map<number, number>();
  const closeLevels = (level: number, inclusive: boolean) => {
    for (const k of [...open]) {
      if (k > level || (inclusive && k === level)) {
        open.delete(k);
        counters.delete(k);
      }
    }
  };
  const levelFor = (indent: number) => {
    const parent = open.size ? Math.max(...open) : -1;
    return Math.min(snappedLevel(indent), parent + 1);
  };
  return text
    .split("\n")
    .map((line) => {
      const o = ORDERED_RE.exec(line);
      if (o) {
        const level = levelFor(o[1].length);
        closeLevels(level, false);
        open.add(level);
        const n = (counters.get(level) ?? 0) + 1;
        counters.set(level, n);
        return `${INDENT.repeat(level)}${n}. ${o[3]}`;
      }
      const b = BULLET_RE.exec(line);
      if (b) {
        const level = levelFor(b[1].length);
        closeLevels(level, true);
        open.add(level);
        return `${INDENT.repeat(level)}${b[2]} ${b[3]}`;
      }
      if (line.trim() === "") return line;
      closeLevels(snappedLevel(line.length - line.trimStart().length), true);
      return line;
    })
    .join("\n");
}

function lineIndexAt(lines: string[], pos: number): { idx: number; col: number } {
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const end = offset + lines[i].length;
    if (pos <= end) return { idx: i, col: pos - offset };
    offset = end + 1;
  }
  const last = lines.length - 1;
  return { idx: last, col: lines[last].length };
}

function offsetOf(lines: string[], idx: number, col: number): number {
  let offset = 0;
  for (let i = 0; i < idx; i++) offset += lines[i].length + 1;
  return offset + Math.max(0, Math.min(col, lines[idx].length));
}

// Applies fn to every line the selection touches, normalises the whole text,
// and re-derives the selection line-by-line so the caret rides along with the
// marker/indent changes (which all happen at the start of a line).
function mapSelectedLines(
  value: string,
  selStart: number,
  selEnd: number,
  fn: (line: string) => string,
): FormatResult {
  const lines = value.split("\n");
  const a = lineIndexAt(lines, selStart);
  // A selection ending right after a line's "\n" should not pull in that
  // next, empty line.
  const b = lineIndexAt(lines, selEnd > selStart && value[selEnd - 1] === "\n" ? selEnd - 1 : selEnd);
  const changed = lines.map((line, i) => (i >= a.idx && i <= b.idx ? fn(line) : line));
  const out = normalizeLists(changed.join("\n")).split("\n");
  const newStart = offsetOf(out, a.idx, a.col + (out[a.idx].length - lines[a.idx].length));
  const newEnd =
    selEnd === selStart
      ? newStart
      : Math.max(newStart, offsetOf(out, b.idx, b.col + (out[b.idx].length - lines[b.idx].length)));
  return { value: out.join("\n"), selStart: newStart, selEnd: newEnd };
}

// Toggles list markers on the selected lines: if every non-blank line already
// carries the requested kind, strip it; otherwise (re)mark each line.
export function toggleList(
  value: string,
  selStart: number,
  selEnd: number,
  kind: "ordered" | "bullet",
): FormatResult {
  const lines = value.split("\n");
  const a = lineIndexAt(lines, selStart);
  const b = lineIndexAt(lines, selEnd > selStart && value[selEnd - 1] === "\n" ? selEnd - 1 : selEnd);
  const re = kind === "ordered" ? ORDERED_RE : BULLET_RE;
  const allMarked = lines
    .slice(a.idx, b.idx + 1)
    .filter((l) => l.trim() !== "")
    .every((l) => re.test(l));
  return mapSelectedLines(value, selStart, selEnd, (line) => {
    if (line.trim() === "") return line;
    const o = ORDERED_RE.exec(line);
    const bl = BULLET_RE.exec(line);
    const indent = (o ?? bl)?.[1] ?? line.slice(0, line.length - line.trimStart().length);
    const body = (o ?? bl)?.[3] ?? line.trimStart();
    if (allMarked) return `${indent}${body}`;
    return kind === "ordered" ? `${indent}1. ${body}` : `${indent}* ${body}`;
  });
}

export function indentLines(value: string, selStart: number, selEnd: number): FormatResult {
  return mapSelectedLines(value, selStart, selEnd, (line) => (line.trim() === "" ? line : INDENT + line));
}

export function outdentLines(value: string, selStart: number, selEnd: number): FormatResult {
  return mapSelectedLines(value, selStart, selEnd, (line) => {
    const lead = line.length - line.trimStart().length;
    return line.slice(Math.min(lead, INDENT.length));
  });
}

// "Tidy outline": normalise without changing any line's content. Keeps the
// caret on the same line and column (adjusted for that line's indent change).
export function tidyLists(value: string, selStart: number, selEnd: number): FormatResult {
  return mapSelectedLines(value, selStart, selEnd, (line) => line);
}

export function isListLine(value: string, pos: number): boolean {
  const lines = value.split("\n");
  const line = lines[lineIndexAt(lines, pos).idx];
  return ORDERED_RE.test(line) || BULLET_RE.test(line);
}

// Enter inside a list item continues the list with the next marker. Enter on
// an empty item outdents it one level (Word behaviour), or at the top level
// ends the list by dropping the marker. Returns null when the caret is not at
// the end of a list line so the textarea's default Enter applies.
export function continueListOnEnter(value: string, selStart: number, selEnd: number): FormatResult | null {
  if (selStart !== selEnd) return null;
  const lines = value.split("\n");
  const { idx, col } = lineIndexAt(lines, selStart);
  const line = lines[idx];
  if (col !== line.length) return null;
  const o = ORDERED_RE.exec(line);
  const b = BULLET_RE.exec(line);
  if (!o && !b) return null;
  const m = (o ?? b)!;
  const marker = o ? "1. " : `${b![2]} `;
  let caretLine: number;
  if (m[3].trim() === "") {
    if (snappedLevel(m[1].length) >= 1) {
      lines[idx] = `${m[1].slice(INDENT.length)}${marker}`;
    } else {
      lines[idx] = "";
    }
    caretLine = idx;
  } else {
    lines.splice(idx + 1, 0, `${m[1]}${marker}`);
    caretLine = idx + 1;
  }
  const out = normalizeLists(lines.join("\n")).split("\n");
  const pos = offsetOf(out, caretLine, out[caretLine].length);
  return { value: out.join("\n"), selStart: pos, selEnd: pos };
}

// Wraps the selection in `**`, or unwraps it when already bold.
export function toggleBold(value: string, selStart: number, selEnd: number): FormatResult {
  const sel = value.slice(selStart, selEnd);
  if (sel.startsWith("**") && sel.endsWith("**") && sel.length >= 4) {
    const inner = sel.slice(2, -2);
    return { value: value.slice(0, selStart) + inner + value.slice(selEnd), selStart, selEnd: selStart + inner.length };
  }
  if (value.slice(selStart - 2, selStart) === "**" && value.slice(selEnd, selEnd + 2) === "**") {
    return {
      value: value.slice(0, selStart - 2) + sel + value.slice(selEnd + 2),
      selStart: selStart - 2,
      selEnd: selEnd - 2,
    };
  }
  return {
    value: value.slice(0, selStart) + `**${sel}**` + value.slice(selEnd),
    selStart: selStart + 2,
    selEnd: selEnd + 2,
  };
}
