import type { DraftRecord } from "./drafts.ts";
import type { OutboxOp } from "./outbox.ts";
import { extractEditableText, normalizeEditable } from "../lib/usfm.ts";

function legacyOpCapturedDraft(draft: DraftRecord, op: OutboxOp): boolean {
  const draftPlain = (draft.payload as { plainText?: unknown }).plainText;
  if (typeof draftPlain !== "string") return false;
  const queuedContent = (op.patch as { content?: unknown }).content;
  if (queuedContent === undefined) return false;
  return extractEditableText(queuedContent) === normalizeEditable(draftPlain);
}

// True only while this exact verse target is actively making its way to the
// server. Conflicts and failed operations deliberately return false: those need
// the existing off-screen reminder and recovery UI rather than being hidden.
export function verseDraftHasActiveSave(draft: DraftRecord, ops: OutboxOp[]): boolean {
  if (draft.meta.kind !== "verse") return false;
  const meta = draft.meta;
  const generation = draft.generation ?? `legacy:${draft.updatedAt}`;
  return ops.some((op) => {
    const target = op.target;
    // Operations persisted by the previous app version have no generation.
    // Require exact payload provenance: target + timestamp alone cannot tell a
    // text save from an unrelated alignment/restore/find-replace operation.
    const capturesDraft = op.draftGeneration
      ? op.draftGeneration === generation
      : legacyOpCapturedDraft(draft, op);
    return (
      (op.status === "pending" || op.status === "in_flight") &&
      capturesDraft &&
      target.kind === "verse" &&
      target.book === meta.book &&
      target.chapter === meta.chapter &&
      target.verse === meta.verse &&
      target.bibleVersion === meta.bibleVersion
    );
  });
}

export function generationForSuccessfulOp(
  draft: DraftRecord | undefined,
  op: OutboxOp,
): string | undefined {
  if (!draft) return undefined;
  const generation = draft.generation ?? `legacy:${draft.updatedAt}`;
  if (op.draftGeneration) {
    return op.draftGeneration === generation ? generation : undefined;
  }
  // Upgrade compatibility for an operation queued before draft generations
  // existed. Clear only when its durable queued content reconstructs to the
  // exact editable text in the draft; otherwise provenance is unknowable.
  return legacyOpCapturedDraft(draft, op) ? generation : undefined;
}

// What the outbox-ok listener should do about the verse-base pin (and draft)
// for a landed verse op. clearGeneration releases the pin itself when it
// deletes the latest draft, so the only case needing an explicit unpin is the
// draftless save: the dual-aligner reading line holds edits in the DOM (no
// keystroke stash) and calls saveVerseDraft directly, which pins a baseline at
// save time — and with no draft record, no clear ever runs, so the pin
// outlived the session and every later text save of the verse diffed against
// it. That stale diff drops alignments added since the pin, and the server's
// guardBlocksSave refuses the re-armed resend ("unexpected_alignment_loss" —
// issue #563). When a draft EXISTS but this op can't be tied to it (generation
// mismatch = newer typing raced ahead), the pin must STAY — it is exactly what
// protects that newer typing's baseline (#474).
export type PinRelease =
  | { kind: "clear"; generation: string }
  | { kind: "unpin" }
  | { kind: "keep" };

export function pinReleaseAfterVerseOk(
  draft: DraftRecord | undefined,
  op: OutboxOp,
): PinRelease {
  return pinReleaseForVerseExit(draft, verseOpExitInfo(op, "ok"));
}

// A verse op leaving the outbox for good, described without the op itself so
// the description can cross a BroadcastChannel. The pin map (versePin.ts) is
// per-tab memory but the outbox is shared IndexedDB with a cross-tab-exclusive
// drain, so the tab that observes an op's exit is often NOT the tab holding
// the pin — every tab must run the release rule itself (#565).
//
// - "ok": the save landed (200).
// - "locked": the chapter was mid-AI-pipeline; the op was DELETED permanently
//   (outbox drain), so nothing will ever land to release the pin.
// - "discarded": the user removed the op (SyncStatusBar discard flows), the
//   other permanent deletion that no 200 will ever follow.
export type VerseOpExit = "ok" | "locked" | "discarded";

export interface VerseOpExitInfo {
  exit: VerseOpExit;
  draftGeneration?: string;
  // extractEditableText(op.patch.content), precomputed by the announcing tab
  // so a receiving tab can run the legacy provenance check without the op.
  editableText?: string;
}

export function verseOpExitInfo(op: OutboxOp, exit: VerseOpExit): VerseOpExitInfo {
  if (op.draftGeneration) return { exit, draftGeneration: op.draftGeneration };
  const content = (op.patch as { content?: unknown } | undefined)?.content;
  return {
    exit,
    ...(content !== undefined ? { editableText: extractEditableText(content) } : {}),
  };
}

// generationForSuccessfulOp over the wire-safe exit description instead of
// the op. Same provenance rule: an explicit generation must match exactly;
// a legacy (pre-generation) op matches only when its queued editable text
// reconstructs the draft's.
function generationCapturedByExit(
  draft: DraftRecord,
  info: VerseOpExitInfo,
): string | undefined {
  const generation = draft.generation ?? `legacy:${draft.updatedAt}`;
  if (info.draftGeneration) {
    return info.draftGeneration === generation ? generation : undefined;
  }
  if (info.editableText === undefined) return undefined;
  const draftPlain = (draft.payload as { plainText?: unknown }).plainText;
  if (typeof draftPlain !== "string") return undefined;
  return info.editableText === normalizeEditable(draftPlain) ? generation : undefined;
}

// The one pin-release rule, for every terminal exit of a verse op:
//
// - "ok" keeps the #563 behavior: clear the matching draft generation
//   (clearGeneration unpins as it deletes), keep the pin when an unmatched
//   draft means newer typing still depends on it (#474), unpin when the save
//   was draftless.
// - "locked" / "discarded" delete the op with the user's text UNSAVED. A
//   draft, when one exists, is the only copy of that text and must SURVIVE —
//   never clear, and keep the pin protecting its baseline. Only the draftless
//   pin releases; without that, a reading-line save against a locked chapter
//   (or a discarded refused op) poisons the verse for the session (#565).
export function pinReleaseForVerseExit(
  draft: DraftRecord | undefined,
  info: VerseOpExitInfo,
): PinRelease {
  if (!draft) return { kind: "unpin" };
  if (info.exit !== "ok") return { kind: "keep" };
  const generation = generationCapturedByExit(draft, info);
  if (generation) return { kind: "clear", generation };
  return { kind: "keep" };
}

// Associate a save only with the draft whose payload it actually captured.
// If typing raced ahead after the click, the payload differs and the older save
// must not clear that newer generation when it succeeds.
export function generationForSavedPlain(
  draft: DraftRecord | undefined,
  plain: string,
): string | undefined {
  if (!draft) return undefined;
  const payload = draft.payload as { plainText?: unknown };
  const generation = draft.generation ?? `legacy:${draft.updatedAt}`;
  return payload.plainText === plain ? generation : undefined;
}
