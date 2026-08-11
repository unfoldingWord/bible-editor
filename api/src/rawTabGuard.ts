// A tn/tq/twl text field (note, question, response, quote, tags,
// support_reference, orig_words, tw_link, ref_raw, ...) is rendered as one
// TSV cell at export (tsvCell in export.ts), which silently converts a raw
// TAB into a single space. That turns structural corruption — a raw TSV
// row's own leading columns pasted into a text field, e.g. ISA tn rows ee2w
// / l9fr, where "front:intro\tl9fr\t\t\t\t0\t" was pasted ahead of the real
// note — into silent, symptom-free content loss at export time. Reject any
// raw TAB in a string field BEFORE it is ever stored, so the corruption can
// never reach D1. Shared by the tn/tq/twl create and patch handlers in
// rows.ts; pure so it can be unit-tested without dragging in Hono/D1.
export function findRawTabField(obj: Record<string, unknown>): string | null {
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (typeof v === "string" && v.includes("\t")) return key;
  }
  return null;
}
