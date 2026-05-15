// Intercepts straight ' and " in any editable field (input, textarea,
// contentEditable) and inserts curly equivalents instead. Straight quotes
// break our TSV format, so we normalize at input time.
//
// Decision rule: a quote is "opening" when the preceding character is
// missing, whitespace, or another opener-ish punctuation; otherwise it's
// closing. This makes ' double as a contextual apostrophe (don't → don’t).

const LDQUO = "“";
const RDQUO = "”";
const LSQUO = "‘";
const RSQUO = "’";

function isOpeningContext(prev: string | undefined): boolean {
  if (!prev) return true;
  if (/\s/.test(prev)) return true;
  return /[(\[{<\-–—/“‘]/.test(prev);
}

function curlyFor(ch: '"' | "'", prev: string | undefined): string {
  if (ch === '"') return isOpeningContext(prev) ? LDQUO : RDQUO;
  return isOpeningContext(prev) ? LSQUO : RSQUO;
}

export function curlifyString(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      out += curlyFor(ch as '"' | "'", out[out.length - 1]);
    } else {
      out += ch;
    }
  }
  return out;
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
  if (data !== '"' && data !== "'") return;
  if (ev.isComposing) return;
  if (ev.inputType !== "insertText" && ev.inputType !== "insertCompositionText") return;

  const target = ev.target;

  if (isTextInput(target) || isTextarea(target)) {
    if (target.readOnly || target.disabled) return;
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    const prev = start > 0 ? target.value[start - 1] : undefined;
    const curly = curlyFor(data, prev);
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
    let prev: string | undefined;
    const { startContainer, startOffset } = range;
    if (startContainer.nodeType === Node.TEXT_NODE && startOffset > 0) {
      prev = (startContainer as Text).data[startOffset - 1];
    }
    const curly = curlyFor(data, prev);
    ev.preventDefault();
    document.execCommand("insertText", false, curly);
  }
}

function handlePaste(e: ClipboardEvent) {
  const target = e.target;
  const text = e.clipboardData?.getData("text/plain");
  if (!text) return;
  if (!/['"]/.test(text)) return;

  if (isTextInput(target) || isTextarea(target)) {
    if (target.readOnly || target.disabled) return;
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    const prev = start > 0 ? target.value[start - 1] : undefined;
    const seeded = curlifyString((prev ?? "") + text).slice(prev ? 1 : 0);
    e.preventDefault();
    setNativeValue(target, target.value.slice(0, start) + seeded + target.value.slice(end));
    const caret = start + seeded.length;
    target.setSelectionRange(caret, caret);
    return;
  }

  if (isContentEditable(target)) {
    const sel = window.getSelection();
    let prev: string | undefined;
    if (sel && sel.rangeCount > 0) {
      const r = sel.getRangeAt(0);
      if (r.startContainer.nodeType === Node.TEXT_NODE && r.startOffset > 0) {
        prev = (r.startContainer as Text).data[r.startOffset - 1];
      }
    }
    const seeded = curlifyString((prev ?? "") + text).slice(prev ? 1 : 0);
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
