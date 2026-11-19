// Quote matching for the print preview ("Quotes" toggle). Chapters with deep
// nested speech (“ ‘ “ … ”’”) are hard to balance by eye, and a quote left open
// early in a book silently shifts every later chapter one level deeper. This
// walks the print preview's OWN rendered HTML (renderPrintPreviewHtml output),
// so it checks exactly the text a reader sees, in reading order, and:
//
//   - wraps every quote mark in a span coloured by nesting level, with a small
//     pair number so an opener and its closer can be found by eye;
//   - flags marks that close nothing, quotes closed out of order, and quotes
//     never closed;
//   - takes the quotes still open from earlier chapters (`carryIn`) and shows
//     them as a badge beside each chapter number they carry into.
//
// Convention assumed (ULT/UST): a plain stack. Double and single quotes
// alternate by level; a new paragraph does NOT repeat the open marks. ’ is
// both the closing single quote and the apostrophe: between two letters it is
// always an apostrophe; after a letter and before a non-letter (`sisters’ `,
// `‘go’ `) it closes a ‘ only when a ‘ is the innermost open quote, and that
// close is marked uncertain. Footnotes and headings are skipped (their quotes
// are self-contained); straight `"` cannot be matched and is reported.
//
// Recovery keeps one mistake from poisoning the rest of the book: a ” that
// meets an open ‘ closes the nearest open “ and reports the skipped ‘ as never
// closed (and the same for ’ meeting an open “).

export type OpenMark = "“" | "‘";

export interface QuoteRef {
  chapter: number;
  // Verse label as printed ("3", "3-4"), or "front" before verse 1.
  verse: string;
}

export interface OpenQuote {
  mark: OpenMark;
  ref: QuoteRef;
}

export interface QuoteProblem {
  ref: QuoteRef;
  severity: "error" | "warning";
  message: string;
}

export interface QuoteResult {
  html: string;
  pairs: number;
  problems: QuoteProblem[];
  // Open at the very start (carried in) and at the very end of the rendered text.
  carriedIn: OpenQuote[];
  openAtEnd: OpenQuote[];
}

export interface QuoteOptions {
  carryIn?: OpenQuote[];
  // True when the rendered text runs to the end of the book: anything still
  // open is then an error, not just "continues in a later chapter".
  atBookEnd?: boolean;
}

const CLOSE_FOR: Record<OpenMark, string> = { "“": "”", "‘": "’" };

interface Opener {
  id: number;
  mark: OpenMark;
  ref: QuoteRef;
  level: number;
  closedAt: QuoteRef | null;
  status: "ok" | "unclosed" | "open-at-end";
  note: string | null;
  carried: boolean;
}

interface MarkEvent {
  // Flat-text index of the mark (for prev/next character lookups).
  at: number;
  raw: string; // the mark as it appears in the HTML (`&quot;` for a straight quote)
  ref: QuoteRef;
  kind: "open" | "close" | "apostrophe" | "straight";
  opener: Opener | null;
  level: number;
  cls: "" | "qm-bad" | "qm-warn" | "qm-open";
  title: string;
}

type Token =
  | { t: "html"; s: string }
  | { t: "chapter"; s: string; carry: Opener[] }
  | { t: "text"; parts: (string | MarkEvent)[] };

const TOKEN_RE =
  /<span class="marks_chapter_label">(?:<span class="usfm-marker">[^<]*<\/span>)?(\d+)<\/span>|<span class="marks_verses_label">(?:<span class="usfm-marker">[^<]*<\/span>)?([\d-]+)<\/span>|<span class="usfm-marker">[^<]*<\/span>|<[^>]*>|[^<]+/g;
const MARK_RE = /&quot;|[“”‘’]/g;
const LETTER_RE = /[\p{L}\p{M}]/u;

export function formatRef(ref: QuoteRef): string {
  return `${ref.chapter}:${ref.verse}`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function annotateQuotes(html: string, opts: QuoteOptions = {}): QuoteResult {
  const tokens: Token[] = [];
  const events: MarkEvent[] = [];
  let flat = "";
  let ref: QuoteRef = { chapter: 0, verse: "front" };
  let footnoteDepth = 0;
  let inHeading = false;

  // Pass 1: tokenize, tracking chapter/verse from the renderer's labels and
  // collecting every quote mark in main reading text.
  const chapterTokens: { tok: Extract<Token, { t: "chapter" }>; at: number }[] = [];
  for (const m of html.matchAll(TOKEN_RE)) {
    const s = m[0];
    if (m[1] !== undefined) {
      ref = { chapter: Number(m[1]), verse: "front" };
      const tok = { t: "chapter" as const, s, carry: [] as Opener[] };
      tokens.push(tok);
      chapterTokens.push({ tok, at: events.length });
      continue;
    }
    if (m[2] !== undefined) {
      ref = { chapter: ref.chapter, verse: m[2] };
      tokens.push({ t: "html", s });
      flat += " ";
      continue;
    }
    if (s.startsWith('<span class="usfm-marker">')) {
      // A whole Markers-mode label: never reading text, never nesting.
      tokens.push({ t: "html", s });
      continue;
    }
    if (s.startsWith("<")) {
      if (footnoteDepth > 0) {
        if (s.startsWith("<span")) footnoteDepth++;
        else if (s === "</span>") footnoteDepth--;
      } else if (s.startsWith('<span class="paras_usfm_f footnote"')) {
        footnoteDepth = 1;
      } else if (/^<h[1-6][\s>]/.test(s)) {
        inHeading = true;
      } else if (/^<\/h[1-6]>/.test(s)) {
        inHeading = false;
      }
      tokens.push({ t: "html", s });
      continue;
    }
    if (footnoteDepth > 0 || inHeading) {
      tokens.push({ t: "html", s });
      continue;
    }
    const parts: (string | MarkEvent)[] = [];
    let last = 0;
    for (const q of s.matchAll(MARK_RE)) {
      const i = q.index!;
      if (i > last) parts.push(s.slice(last, i));
      const ev: MarkEvent = {
        at: flat.length + i,
        raw: q[0],
        ref,
        kind: "apostrophe",
        opener: null,
        level: 0,
        cls: "",
        title: "",
      };
      parts.push(ev);
      events.push(ev);
      last = i + q[0].length;
    }
    if (last < s.length) parts.push(s.slice(last));
    tokens.push({ t: "text", parts });
    flat += s;
  }

  // Pass 2: the stack.
  const problems: QuoteProblem[] = [];
  const openers: Opener[] = [];
  const stack: Opener[] = [];
  let nextId = 1;
  let pairs = 0;
  const push = (mark: OpenMark, at: QuoteRef, carried: boolean): Opener => {
    const o: Opener = { id: nextId++, mark, ref: at, level: stack.length + 1, closedAt: null, status: "ok", note: null, carried };
    stack.push(o);
    openers.push(o);
    return o;
  };
  const carriedIn = (opts.carryIn ?? []).map((c) => ({ ...c }));
  for (const c of carriedIn) push(c.mark, c.ref, true);

  const isLetter = (i: number): boolean => i >= 0 && i < flat.length && LETTER_RE.test(flat[i]);
  const isSpaceOrEnd = (i: number): boolean => i < 0 || i >= flat.length || /\s/.test(flat[i]);

  // Close `o` (somewhere in the stack) at `ev`; anything above it is reported
  // as never closed.
  const closeTo = (o: Opener, ev: MarkEvent): void => {
    while (stack.length > 0) {
      const top = stack.pop()!;
      if (top === o) break;
      top.status = "unclosed";
      top.note = `the ${CLOSE_FOR[o.mark]} at ${formatRef(ev.ref)} closed the outer ${o.mark} first`;
      problems.push({
        ref: top.ref,
        severity: "error",
        message: `${top.mark}${top.id} is never closed: the ${CLOSE_FOR[o.mark]} at ${formatRef(ev.ref)} closes the outer ${o.mark}${o.id} (from ${formatRef(o.ref)}) while it is still open`,
      });
    }
    o.closedAt = ev.ref;
    ev.kind = "close";
    ev.opener = o;
    ev.level = o.level;
    pairs++;
  };
  const findOpen = (mark: OpenMark): Opener | undefined => {
    for (let k = stack.length - 1; k >= 0; k--) if (stack[k].mark === mark) return stack[k];
    return undefined;
  };

  const sameKindByOuter = new Map<Opener, QuoteProblem & { outer: Opener; mark: OpenMark; count: number }>();
  let evIdx = 0;
  const chapterQueue = [...chapterTokens];
  for (; evIdx <= events.length; evIdx++) {
    // Snapshot the stack for every chapter label that comes before this mark.
    while (chapterQueue.length > 0 && chapterQueue[0].at <= evIdx) chapterQueue.shift()!.tok.carry = [...stack];
    if (evIdx === events.length) break;
    const ev = events[evIdx];
    const prevLetter = isLetter(ev.at - 1);
    const nextLetter = isLetter(ev.at + ev.raw.length);
    const top = stack[stack.length - 1];

    if (ev.raw === "&quot;") {
      ev.kind = "straight";
      ev.cls = "qm-bad";
      ev.title = "Straight quote mark: can't tell whether it opens or closes. Use “ ” or ‘ ’.";
      problems.push({ ref: ev.ref, severity: "error", message: "straight \" quote mark — use “ or ”" });
      continue;
    }
    if (ev.raw === "“" || ev.raw === "‘") {
      const mark = ev.raw as OpenMark;
      const sameKind = top?.mark === mark;
      const o = push(mark, ev.ref, false);
      ev.kind = "open";
      ev.opener = o;
      ev.level = o.level;
      if (sameKind) {
        ev.cls = "qm-warn";
        ev.title = `Opens directly inside another ${mark} (${mark}${top!.id} from ${formatRef(top!.ref)}): nested quotes normally switch between “ and ‘. Is a closing mark missing earlier?`;
        // One warning per outer quote: a single missing close otherwise warns
        // at every later speech for the rest of the book.
        const seen = sameKindByOuter.get(top!);
        if (seen) seen.count++;
        else {
          const w = { ref: ev.ref, severity: "warning" as const, message: "", outer: top!, mark, count: 1 };
          sameKindByOuter.set(top!, w);
          problems.push(w);
        }
      } else if (isSpaceOrEnd(ev.at + 1) && !isSpaceOrEnd(ev.at - 1)) {
        ev.cls = "qm-warn";
        problems.push({ ref: ev.ref, severity: "warning", message: `${mark} is followed by a space — should it be ${CLOSE_FOR[mark]}?` });
      }
      continue;
    }
    if (ev.raw === "”") {
      const o = findOpen("“");
      if (!o) {
        ev.kind = "close";
        ev.cls = "qm-bad";
        ev.title = "Closes nothing: no “ is open here.";
        problems.push({ ref: ev.ref, severity: "error", message: "” closes nothing — no “ is open here" });
        continue;
      }
      closeTo(o, ev);
      if (isSpaceOrEnd(ev.at - 1) && nextLetter) {
        ev.cls = "qm-warn";
        problems.push({ ref: ev.ref, severity: "warning", message: "” is followed by a letter after a space — should it be “?" });
      }
      continue;
    }
    // ’ — apostrophe or closing single quote.
    if (prevLetter && nextLetter) continue; // don't, Yahweh’s
    if (top?.mark === "‘") {
      closeTo(top, ev);
      if (prevLetter) {
        ev.cls = "qm-warn";
        ev.title = "Read as closing ‘ — if this is a possessive (sisters’), the quote is still open.";
      }
      continue;
    }
    if (prevLetter) continue; // sisters’ (possessive) — no ‘ to close
    const o = findOpen("‘");
    if (o) {
      closeTo(o, ev);
      continue;
    }
    ev.kind = "close";
    ev.cls = "qm-bad";
    ev.title = "Closes nothing: no ‘ is open here.";
    problems.push({ ref: ev.ref, severity: "error", message: "’ closes nothing — no ‘ is open here" });
  }

  const openAtEnd: OpenQuote[] = stack.map((o) => ({ mark: o.mark, ref: o.ref }));
  for (const o of stack) {
    o.status = opts.atBookEnd ? "unclosed" : "open-at-end";
    if (opts.atBookEnd) {
      problems.push({ ref: o.ref, severity: "error", message: `${o.mark}${o.id} is never closed (still open at the end of the book)` });
    }
  }

  for (const w of sameKindByOuter.values()) {
    const o = w.outer;
    w.message =
      `${w.mark} opens directly inside ${o.mark}${o.id} (from ${formatRef(o.ref)})` +
      (w.count > 1 ? `, and ${w.count - 1} more ${w.mark} after it do too` : "") +
      `; nested quotes normally switch between “ and ‘ — is ${o.mark}${o.id} missing its closing ${CLOSE_FOR[o.mark]}?`;
    delete (w as Partial<typeof w>).outer;
  }

  // Pass 3: emit.
  const markHtml = (ev: MarkEvent): string => {
    if (ev.kind === "apostrophe") return ev.raw;
    const o = ev.opener;
    let cls = ev.cls;
    let title = ev.title;
    if (o) {
      if (ev.kind === "open") {
        if (o.status === "unclosed") cls = "qm-bad";
        else if (o.status === "open-at-end" && cls === "") cls = "qm-open";
        const end =
          o.status === "ok"
            ? `closed at ${formatRef(o.closedAt!)}`
            : o.status === "open-at-end"
              ? "still open at the end of this text — continues later?"
              : `never closed${o.note ? ` (${o.note})` : ""}`;
        title ||= `Opens quote ${o.id} (level ${o.level}); ${end}.`;
      } else {
        title ||= `Closes quote ${o.id} (level ${o.level}), opened at ${formatRef(o.ref)}${o.carried ? " (an earlier chapter)" : ""}.`;
      }
    }
    const lvl = ev.level > 0 ? ` qm-l${((ev.level - 1) % 4) + 1}` : "";
    const num = o ? `<sub class="qm-n">${o.id}</sub>` : "";
    return `<span class="qm${lvl}${cls ? ` ${cls}` : ""}" title="${escapeAttr(title)}">${ev.raw}${num}</span>`;
  };
  const out = tokens
    .map((tok) => {
      if (tok.t === "html") return tok.s;
      if (tok.t === "text") return tok.parts.map((p) => (typeof p === "string" ? p : markHtml(p))).join("");
      if (tok.carry.length === 0) return tok.s;
      const list = tok.carry.map((o) => `${o.mark}${o.id} ${formatRef(o.ref)}`).join(", ");
      const badge = tok.carry
        .map((o) => `<span class="qm qm-l${((o.level - 1) % 4) + 1}">${o.mark}<sub class="qm-n">${o.id}</sub></span>`)
        .join("");
      return `${tok.s}<span class="qm-carry" title="${escapeAttr(`Still open from before this chapter: ${list}`)}">open from before: ${badge}</span>`;
    })
    .join("");

  // Problems in reading order: carried-in ones have earlier refs, so sort.
  const order = (r: QuoteRef): number => r.chapter * 1000 + (r.verse === "front" ? 0 : parseInt(r.verse, 10) || 0);
  problems.sort((a, b) => order(a.ref) - order(b.ref));

  return { html: out, pairs, problems, carriedIn, openAtEnd };
}

export interface QuoteSummaryContext {
  // "book": whole book rendered, nothing to carry in. "ready": carry-in was
  // computed from earlier chapters with `earlierErrors` errors among them.
  // "loading" / "failed": carry-in could not be computed (yet).
  carry: { state: "book" } | { state: "ready"; earlierErrors: number } | { state: "loading" } | { state: "failed" };
}

// The box above the text: counts, carry-in, problems, what stays open, legend.
export function quoteSummaryHtml(r: QuoteResult, ctx: QuoteSummaryContext): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const list = (qs: OpenQuote[]) => qs.map((q) => `${q.mark} ${formatRef(q.ref)}`).join(", ");
  const errors = r.problems.filter((p) => p.severity === "error").length;
  const warnings = r.problems.length - errors;
  const lines: string[] = [];
  lines.push(
    `<div class="qm-head"><strong>Quote check:</strong> ${r.pairs} pair${r.pairs === 1 ? "" : "s"} matched · ` +
      `${errors === 0 ? "no errors" : `<span class="qm-sum-bad">${errors} error${errors === 1 ? "" : "s"}</span>`}` +
      `${warnings ? ` · <span class="qm-sum-warn">${warnings} to check</span>` : ""}</div>`,
  );
  const c = ctx.carry;
  if (c.state === "loading") lines.push(`<div>Checking earlier chapters for quotes still open…</div>`);
  else if (c.state === "failed") lines.push(`<div class="qm-sum-warn">Could not load earlier chapters, so quotes opened before this chapter are not counted.</div>`);
  else if (c.state === "ready") {
    lines.push(
      r.carriedIn.length
        ? `<div><strong>Open from earlier chapters:</strong> ${esc(list(r.carriedIn))}</div>`
        : `<div>No quotes are open from earlier chapters.</div>`,
    );
    if (c.earlierErrors > 0) {
      lines.push(
        `<div class="qm-sum-warn">Earlier chapters have ${c.earlierErrors} quote error${c.earlierErrors === 1 ? "" : "s"}, so what carries into this chapter may be wrong. Switch to Whole book to see them.</div>`,
      );
    }
  }
  if (r.problems.length) {
    lines.push(
      `<ul class="qm-problems">${r.problems
        .map((p) => `<li class="${p.severity === "error" ? "qm-sum-bad" : "qm-sum-warn"}">${formatRef(p.ref)} — ${esc(p.message)}</li>`)
        .join("")}</ul>`,
    );
  }
  if (r.openAtEnd.length && c.state !== "book") {
    lines.push(`<div><strong>Still open at the end:</strong> ${esc(list(r.openAtEnd))} (fine if they close in a later chapter)</div>`);
  }
  lines.push(
    `<div class="qm-legend">Level: <span class="qm qm-l1">“</span> 1 · <span class="qm qm-l2">‘</span> 2 · <span class="qm qm-l3">“</span> 3 · <span class="qm qm-l4">‘</span> 4 · ` +
      `small numbers pair an opening mark with its closing mark · <span class="qm qm-bad">red</span> = error · <span class="qm qm-warn">yellow</span> = check · hover a mark for details</div>`,
  );
  return `<div class="qm-summary">${lines.join("")}</div>\n`;
}
