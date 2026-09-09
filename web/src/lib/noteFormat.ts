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

// Normalises every list line so the outline the author *meant* is the one
// Markdown renders, without changing any words. Never adds or removes lines.
//
// Nesting is read relatively, the way a person reads an outline: within a
// list block, a line indented more than the item before it is that item's
// child, a line indented the same is a sibling, and a line indented less
// closes levels until it matches one. Levels are then written at four spaces
// each, because that is what CommonMark needs — existing intros written with
// two-space parents and four-space children (the ISA convention) render as
// run-on text today because a child must clear the parent's marker.
//
// Ordered items are renumbered in sequence, but a list's *start* number is
// kept: `3. c` resuming after a paragraph renders as 3 under CommonMark and
// stays 3, and a prose line that merely begins with `5. ` is left alone.
export function normalizeLists(text: string): string {
  // Raw indent of each open level (index = level) and each level's last number.
  const stack: number[] = [];
  const counters: number[] = [];
  // Code is literal text — a `3. literal` line inside a ``` fence, or in an
  // indented code block (four-plus spaces with no list open), must not be
  // read as a list item. A fence closes only on the same character, at least
  // as long as the opener, with nothing else on the line.
  let fence: { ch: string; len: number } | null = null;
  let inIndentedCode = false;
  const closeTo = (indent: number, keepEqual: boolean) => {
    while (stack.length && (stack[stack.length - 1] > indent || (!keepEqual && stack[stack.length - 1] === indent))) {
      stack.pop();
      counters.pop();
    }
  };
  const levelFor = (indent: number) => {
    while (stack.length > 1 && stack[stack.length - 1] > indent) {
      stack.pop();
      counters.pop();
    }
    // A top-level item written shallower than the one before it (`1.` after
    // ISA's `  2.`) is still the same list — rebase the level, keep its count.
    if (stack.length === 1 && stack[0] > indent) stack[0] = indent;
    if (!stack.length || stack[stack.length - 1] < indent) stack.push(indent);
    return stack.length - 1;
  };
  return text
    .split("\n")
    .map((line) => {
      const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        if (f && f[1][0] === fence.ch && f[1].length >= fence.len && f[2].trim() === "") fence = null;
        return line;
      }
      if (f) {
        fence = { ch: f[1][0], len: f[1].length };
        stack.length = 0;
        counters.length = 0;
        return line;
      }
      const indent = line.length - line.trimStart().length;
      if (line.trim() === "") return line;
      if (inIndentedCode) {
        if (indent >= INDENT.length) return line;
        inIndentedCode = false;
      } else if (!stack.length && indent >= INDENT.length) {
        inIndentedCode = true;
        return line;
      }
      const o = ORDERED_RE.exec(line);
      if (o) {
        const level = levelFor(o[1].length);
        const n = counters[level] == null ? Number(o[2]) : counters[level] + 1;
        counters[level] = n;
        counters.length = level + 1;
        return `${INDENT.repeat(level)}${n}. ${o[3]}`;
      }
      const b = BULLET_RE.exec(line);
      if (b) {
        const level = levelFor(b[1].length);
        // A bullet at this level ends any ordered run here.
        counters[level] = undefined as unknown as number;
        counters.length = level + 1;
        return `${INDENT.repeat(level)}${b[2]} ${b[3]}`;
      }
      // Prose closes every list level at or deeper than its own indent.
      closeTo(indent, false);
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
  fn: (line: string, index: number, lines: string[]) => string,
): FormatResult {
  const lines = value.split("\n");
  const a = lineIndexAt(lines, selStart);
  // A selection ending right after a line's "\n" should not pull in that
  // next, empty line — but the newline itself stays selected afterwards.
  const endsAfterNewline = selEnd > selStart && value[selEnd - 1] === "\n";
  const b = lineIndexAt(lines, endsAfterNewline ? selEnd - 1 : selEnd);
  const changed = lines.map((line, i) => (i >= a.idx && i <= b.idx ? fn(line, i, lines) : line));
  const out = normalizeLists(changed.join("\n")).split("\n");
  const newStart = offsetOf(out, a.idx, a.col + (out[a.idx].length - lines[a.idx].length));
  const newEnd =
    selEnd === selStart
      ? newStart
      : Math.max(
          newStart,
          offsetOf(out, b.idx, b.col + (out[b.idx].length - lines[b.idx].length)) + (endsAfterNewline ? 1 : 0),
        );
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

// A moved ordered item restarts at 1; normalisation then continues the count
// if it lands next to siblings. (normalizeLists keeps a list's own start
// number otherwise, so the reset has to be explicit here.)
function restartNumber(line: string): string {
  const o = ORDERED_RE.exec(line);
  return o ? `${o[1]}1. ${o[3]}` : line;
}

export function indentLines(value: string, selStart: number, selEnd: number): FormatResult {
  return mapSelectedLines(value, selStart, selEnd, (line, i, lines) => {
    if (line.trim() === "") return line;
    // A list item with no list line above it has nothing to nest under;
    // indenting it would only turn it into an indented code block.
    let p = i - 1;
    while (p >= 0 && lines[p].trim() === "") p--;
    const hasParent = p >= 0 && (ORDERED_RE.test(lines[p]) || BULLET_RE.test(lines[p]));
    if ((ORDERED_RE.test(line) || BULLET_RE.test(line)) && !hasParent) return line;
    return restartNumber(INDENT + line);
  });
}

export function outdentLines(value: string, selStart: number, selEnd: number): FormatResult {
  return mapSelectedLines(value, selStart, selEnd, (line) => {
    const lead = line.length - line.trimStart().length;
    return restartNumber(line.slice(Math.min(lead, INDENT.length)));
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
  const rawLines = value.split("\n");
  const { idx, col } = lineIndexAt(rawLines, selStart);
  if (col !== rawLines[idx].length) return null;
  if (!ORDERED_RE.test(rawLines[idx]) && !BULLET_RE.test(rawLines[idx])) return null;
  // Work on the normalised outline so a legacy mixed-indent note (`1.` / `  1.`
  // / `    1.`) outdents by one *level*, not by four raw spaces.
  const lines = normalizeLists(value).split("\n");
  const line = lines[idx];
  const o = ORDERED_RE.exec(line);
  const b = BULLET_RE.exec(line);
  if (!o && !b) return null;
  const m = (o ?? b)!;
  const marker = o ? "1. " : `${b![2]} `;
  let caretLine: number;
  if (m[3].trim() === "") {
    // Nested: outdent one level. Top level: end the list.
    lines[idx] = m[1].length >= INDENT.length ? `${m[1].slice(INDENT.length)}${marker}` : "";
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
  // Unwrap only a single bold span: `**one** and **two**` selected whole must
  // not lose its outer markers and flip the emphasis onto " and ".
  if (sel.startsWith("**") && sel.endsWith("**") && sel.length >= 4 && !sel.slice(2, -2).includes("**")) {
    const inner = sel.slice(2, -2);
    return { value: value.slice(0, selStart) + inner + value.slice(selEnd), selStart, selEnd: selStart + inner.length };
  }
  if (value.slice(selStart - 2, selStart) === "**" && value.slice(selEnd, selEnd + 2) === "**" && !sel.includes("**")) {
    return {
      value: value.slice(0, selStart - 2) + sel + value.slice(selEnd + 2),
      selStart: selStart - 2,
      selEnd: selEnd - 2,
    };
  }
  // Markers hug the words: `** hello **` is not emphasis in CommonMark.
  const lead = sel.length - sel.trimStart().length;
  const trail = sel.length - sel.trimEnd().length;
  const innerStart = selStart + lead;
  const innerEnd = Math.max(innerStart, selEnd - trail);
  return {
    value: value.slice(0, innerStart) + `**${value.slice(innerStart, innerEnd)}**` + value.slice(innerEnd),
    selStart: innerStart + 2,
    selEnd: innerEnd + 2,
  };
}
