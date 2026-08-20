// Rebase a verse PATCH op onto a newer server row before re-arming it
// (issue #564).
//
// The two re-arm paths — outbox.resolveConflict (the user's "resolve
// conflicts / your edit wins" button) and threadVersionToSiblings (a sibling
// op's 200) — used to bump expectedVersion and re-send the op's content
// VERBATIM. That content was diffed from a baseline older than the server
// row, so a genuinely concurrent save (another tab, another translator, the
// nightly source-attr reconcile) between the op's baseline and its re-arm
// produced one of two bad outcomes:
//   - the stale content DROPS alignments the server row has → the server's
//     guardBlocksSave refuses (`unexpected_alignment_loss`) and the
//     translator's only option is to discard their text edit; or
//   - the stale content CARRIES alignments (or text) the server row moved
//     past → 200, silently reverting the other party's work.
//
// The fix: re-apply the op's TEXT INTENT onto the server's current tree via
// the existing edit engine instead of re-sending the stale tree. Unchanged
// regions keep the server's (newer) alignments; the translator's text edit
// still applies. If the rebased content still trips the server guard, the
// refusal is then truthful — the edit genuinely collides with alignment work.
//
// Scope honesty: this is a 2-way rebase, not a 3-way merge — the op stores
// only its RESULT text, never its baseline, so the op's text wins wholesale.
// What the rebase fixes is the ALIGNMENT side (the server's concurrent
// alignment state is the base, so it can neither be collaterally dropped nor
// resurrected); a concurrent third-party TEXT change is still last-write-wins,
// exactly as the resolve button has always been documented to behave.
//
// Split out of outbox.ts so a plain Node test can import it — outbox.ts
// imports api.ts, whose ApiError uses a TS parameter-property constructor
// Node's `--experimental-strip-types` loader cannot erase (same reason
// outboxTargeting.ts exists). See verseRebase.test.mjs.

import { smartEditVerse } from "../lib/replace.ts";
import { extractEditableText, extractPlainText } from "../lib/usfm.ts";
import { nfc } from "../lib/hebrew.ts";

// Structural view of a verse PATCH op's payload (what enqueueVerse stores).
// `alignment_intent` is api.ts's AlignmentIntent, typed loosely here so this
// module never has to import api.ts (see header).
interface VersePatchShape {
  content?: unknown;
  plain_text?: string | null;
  alignment_intent?: string;
}

export type VerseRebaseOutcome =
  // Send this patch instead of the op's own: the op's text intent re-applied
  // onto the server's current tree, plain_text recomputed.
  | { kind: "rebased"; patch: Record<string, unknown> }
  // Re-send the op's patch as-is (nothing to rebase, rebase not applicable,
  // or the engine failed — the server guard remains the backstop).
  | { kind: "verbatim" }
  // Do not silently re-arm this op onto the newer version at all: it is an
  // alignment_edit whose baseline text no longer matches the server's. Its
  // intent is the alignment STRUCTURE of a text that has since changed;
  // re-sending it verbatim would revert the text change with a clean 200
  // (alignment_edit is guard-exempt). Callers on an AUTOMATIC path leave the
  // op untouched so it 409s and surfaces the conflict prompt; the USER-driven
  // resolve path may still choose verbatim (an explicit "my edit wins").
  | { kind: "refuse_thread" };

// Decide how to re-arm one verse PATCH op onto `serverContent` (the server's
// current verse tree: `conflictCurrent.content` on the resolve path, the 200
// body's `content` on the thread path).
//
// Intent handling:
//   - text_edit / find_replace / absent: rebase via smartEditVerse. NOTE the
//     rebase only carries what extractEditableText can see — content invisible
//     to it (e.g. \f footnote prose) is adopted from the SERVER tree. Nothing
//     user-editable travels that way in a text op today; a future producer of
//     text ops carrying editable-text-invisible changes must not rely on this
//     path preserving them.
//   - alignment_edit: the op's intent is the alignment structure itself, not
//     the text — a text-space rebase would discard it. Verbatim when the
//     server's text still matches the op's (last-write-wins on alignment is
//     the aligner's contract); refuse_thread when the text changed. The
//     intent is overloaded: Shell's guard-confirm "Save anyway" escalation
//     also ships a TEXT edit as alignment_edit (the only guard-exempt
//     intent), and such an op queued behind a pending sibling now surfaces a
//     conflict prompt instead of silently threading. That extra prompt is
//     accepted as the conservative cost — the two cases are indistinguishable
//     here, and rebasing a TRUE aligner save across a text change would
//     discard the alignment work. Resolving the prompt lands the op verbatim
//     (correct content — its tree includes the sibling's edit).
//   - section_edit: section headers (\s1/\s2/\s3) are invisible to
//     extractEditableText, so a text-space rebase would silently drop the
//     op's own \s change. Keep verbatim (pre-#564 behavior).
//
// Text compares go through nfc(): UHB-order combining marks vs NFC-order are
// the same text to a translator and must not read as a text change.
export function rebaseVersePatch(
  patch: Record<string, unknown>,
  serverContent: unknown,
): VerseRebaseOutcome {
  const p = patch as VersePatchShape | null | undefined;
  const content = p?.content;
  if (content == null || serverContent == null || typeof serverContent !== "object") {
    return { kind: "verbatim" };
  }
  let serverText: string;
  let opText: string;
  try {
    serverText = extractEditableText(serverContent);
    opText = extractEditableText(content);
  } catch {
    return { kind: "verbatim" };
  }
  const textUnchanged = nfc(serverText) === nfc(opText);
  const intent = p?.alignment_intent;
  if (intent === "alignment_edit") {
    return textUnchanged ? { kind: "verbatim" } : { kind: "refuse_thread" };
  }
  if (intent === "section_edit") {
    return { kind: "verbatim" };
  }
  try {
    const result = smartEditVerse(serverContent, serverText, opText);
    return {
      kind: "rebased",
      patch: {
        ...patch,
        content: result.content,
        plain_text: extractPlainText(result.content),
      },
    };
  } catch {
    return { kind: "verbatim" };
  }
}
