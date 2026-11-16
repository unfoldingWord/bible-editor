// Intercepts straight ' and " in any editable field (input, textarea,
// contentEditable) and inserts curly equivalents instead. Straight quotes
// break our TSV format, so we normalize at input time. Also collapses a
// third consecutive "." into a single ellipsis character ("…").
//
// Decision rule: a quote is "opening" when the preceding character is
// missing, whitespace, or another opener-ish punctuation; otherwise it's
// closing. This makes ' double as a contextual apostrophe (don't → don’t).
// One exception, for " only: sentence punctuation before it and a letter
// right after it opens (#1380 decision A: `wars;"the` → `wars;“the`), the
// same rule as the verse-tree curlers (curlyVerse.ts, importParsers.ts). A
// keystroke at the end of the text has no letter after it yet, so it still
// closes there.

const LDQUO = "“";
const RDQUO = "”";
const LSQUO = "‘";
const RSQUO = "’";
const ELLIPSIS = "…";

function isOpeningContext(prev: string | undefined): boolean {
  if (!prev) return true;
  if (/\s/.test(prev)) return true;
  return /[(\[{<\-–—/“‘]/.test(prev);
}

// The whole character (code point) starting at `i`, so a letter outside the
// BMP reads as a letter, as in the verse-tree curlers.
function charAt(s: string, i: number): string | undefined {
  const cp = s.codePointAt(i);
  return cp === undefined ? undefined : String.fromCodePoint(cp);
}

// The first character after the caret or selection in a contentEditable,
// looking past the end of the current text node into the next one (`;|` in
// one span, `the` in the next).
function nextCharInEditable(range: Range, root: Node): string | undefined {
  const { endContainer, endOffset } = range;
  if (endContainer.nodeType === Node.TEXT_NODE && endOffset < (endContainer as Text).data.length) {
    return charAt((endContainer as Text).data, endOffset);
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const data = (n as Text).data;
    if (data.length > 0 && range.comparePoint(n, 0) === 1) return charAt(data, 0);
  }
  return undefined;
}

function curlyFor(ch: '"' | "'", prev: string | undefined, next?: string | undefined): string {
  if (ch === '"' && prev !== undefined && /[.,;:!?]/.test(prev) && next !== undefined && /\p{L}/u.test(next)) return LDQUO;
  if (ch === '"') return isOpeningContext(prev) ? LDQUO : RDQUO;
  return isOpeningContext(prev) ? LSQUO : RSQUO;
}

// `prevContext` (optional) is the character immediately before the insertion
// point in the surrounding document — it decides the curl direction of a quote
// at position 0 without ever becoming part of the output. `nextContext`
// (optional) is the character right after the string, for a quote at its end.
export function curlifyString(s: string, prevContext?: string, nextContext?: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      out += curlyFor(ch as '"' | "'", out.length > 0 ? out[out.length - 1] : prevContext, i + 1 < s.length ? charAt(s, i + 1) : nextContext);
    } else {
      out += ch;
    }
  }
  return out.replace(/\.\.\.+/g, ELLIPSIS);
}

// What handlePaste inserts at the caret: the pasted text curlified, with the
// FIRST char's quote direction decided by the character before the caret
// (`prev`). Exported for tests.
//
// `prev` is passed as CONTEXT, never prepended into the curlified string: the
// old prepend-then-slice approach let curlifyString's `...` → "…" collapse
// merge the seed char into an ellipsis (prev "." + pasted "..." became "…",
// and slicing off "the seed" deleted the ellipsis instead), so pasting "..."
// after a period inserted nothing and "...abc" lost its ellipsis.
// `next` is the character after the caret, so a pasted `"` before a word
// can open (#1380).
export function curlifyPaste(text: string, prev: string | undefined, next?: string): string {
  return curlifyString(text, prev, next);
}

// What a paste should insert, or null to let the browser's default paste run.
// An input/textarea only needs rewriting when the text has straight quotes or
// a "..." run. A contentEditable always takes the plain text: the browser's
// default pastes the clipboard's text/html, which carries the source's markup
// (T4T's <em> for \add, the copied cell's color and background spans) into
// the verse editor. textContent still saves the right words, but the foreign
// markup stays in the DOM after the save (the repaint is skipped because the
// text already matches) and newly typed text inherits its italics and color
// until the verse remounts.
export function pasteReplacement(
  text: string,
  prev: string | undefined,
  target: "field" | "editable",
  next?: string,
): string | null {
  if (target === "field" && !/['"]/.test(text) && !/\.\.\.+/.test(text)) return null;
  // insertText turns a newline into a <br> or block split, which textContent
  // reads as nothing, so the words either side would save joined ("1:6But").
  const flat = target === "editable" ? text.replace(/[ \t]*[\r\n][ \t\r\n]*/g, " ") : text;
  return curlifyPaste(flat, prev, next);
}

function isTextInput(el: EventTarget | null): el is HTMLInputElement {
  if (!(el instanceof HTMLInputElement)) return false;
  const t = (el.type || "text").toLowerCase();
  return t === "text" || t === "search" || t === "url" || t === "tel" || t === "";
}

function isTextarea(el: EventTarget | null): el is HTMLTextAreaElement {
  return el instanceof HTMLTextAreaElement;
}

function isContentEditable(el: EventTarget | null): el is HTMLElement {
  return el instanceof HTMLElement && el.isContentEditable;
}

// React installs its own value setter on input/textarea; calling
// `el.value = x` bypasses React's change tracking. The standard workaround
// is to invoke the native prototype setter then dispatch an input event.
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function handleBeforeInput(e: Event) {
  const ev = e as InputEvent;
  const data = ev.data;
  if (data !== '"' && data !== "'" && data !== ".") return;
  if (ev.isComposing) return;
  if (ev.inputType !== "insertText" && ev.inputType !== "insertCompositionText") return;

  const target = ev.target;

  if (isTextInput(target) || isTextarea(target)) {
    if (target.readOnly || target.disabled) return;
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;

    if (data === ".") {
      if (target.value[start - 1] !== "." || target.value[start - 2] !== ".") return;
      ev.preventDefault();
      const before = target.value.slice(0, start - 2);
      const after = target.value.slice(end);
      setNativeValue(target, before + ELLIPSIS + after);
      const caret = before.length + ELLIPSIS.length;
      target.setSelectionRange(caret, caret);
      return;
    }

    const prev = start > 0 ? target.value[start - 1] : undefined;
    const curly = curlyFor(data, prev, charAt(target.value, end));
    ev.preventDefault();
    const before = target.value.slice(0, start);
    const after = target.value.slice(end);
    setNativeValue(target, before + curly + after);
    const caret = start + curly.length;
    target.setSelectionRange(caret, caret);
    return;
  }

  if (isContentEditable(target)) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const { startContainer, startOffset } = range;

    if (data === ".") {
      if (startContainer.nodeType !== Node.TEXT_NODE || startOffset < 2) return;
      const text = (startContainer as Text).data;
      if (text[startOffset - 1] !== "." || text[startOffset - 2] !== ".") return;
      ev.preventDefault();
      const editRange = range.cloneRange();
      editRange.setStart(startContainer, startOffset - 2);
      sel.removeAllRanges();
      sel.addRange(editRange);
      document.execCommand("insertText", false, ELLIPSIS);
      return;
    }

    let prev: string | undefined;
    if (startContainer.nodeType === Node.TEXT_NODE && startOffset > 0) {
      prev = (startContainer as Text).data[startOffset - 1];
    }
    // The character after the caret (or selection), for `;|the` → `;“the`.
    const curly = curlyFor(data, prev, nextCharInEditable(range, target));
    ev.preventDefault();
    document.execCommand("insertText", false, curly);
  }
}

function handlePaste(e: ClipboardEvent) {
  const target = e.target;
  const text = e.clipboardData?.getData("text/plain");
  if (!text) return;

  if (isTextInput(target) || isTextarea(target)) {
    if (target.readOnly || target.disabled) return;
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    const prev = start > 0 ? target.value[start - 1] : undefined;
    const seeded = pasteReplacement(text, prev, "field", charAt(target.value, end));
    if (seeded === null) return;
    e.preventDefault();
    setNativeValue(target, target.value.slice(0, start) + seeded + target.value.slice(end));
    const caret = start + seeded.length;
    target.setSelectionRange(caret, caret);
    return;
  }

  if (isContentEditable(target)) {
    const sel = window.getSelection();
    let prev: string | undefined;
    let next: string | undefined;
    if (sel && sel.rangeCount > 0) {
      const r = sel.getRangeAt(0);
      if (r.startContainer.nodeType === Node.TEXT_NODE && r.startOffset > 0) {
        prev = (r.startContainer as Text).data[r.startOffset - 1];
      }
      next = nextCharInEditable(r, target);
    }
    const seeded = pasteReplacement(text, prev, "editable", next);
    if (seeded === null) return;
    e.preventDefault();
    document.execCommand("insertText", false, seeded);
  }
}

let installed = false;

export function installCurlyQuotes() {
  if (installed) return;
  installed = true;
  document.addEventListener("beforeinput", handleBeforeInput, true);
  document.addEventListener("paste", handlePaste, true);
}
