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
  // #1060: which op this was, the version it was saved against, and (on "ok")
  // the row the server stored, so the tab that QUEUED it can move a live
  // reading-line hold forward even when another tab drained it.
  opId?: string;
  expectedVersion?: number;
  landed?: { version: number; content: unknown };
}

export function verseOpExitInfo(op: OutboxOp, exit: VerseOpExit): VerseOpExitInfo {
  if (op.draftGeneration) return { exit, draftGeneration: op.draftGeneration };
  // The reconstructed editable text is only consulted on "ok" (non-ok exits
  // never clear a draft, so provenance is moot) — and extracting it parses
  // the queued content, which now happens synchronously inside outbox
  // listener dispatch. Don't run that parse, or ship its result, for exits
  // that cannot use it.
  if (exit !== "ok") return { exit };
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

// Whether a landed (200) row op should clear that row's draft (#1092). A row
// draft holds the typed fields as `payload.patch`; the op clears it only when
// it saved at least one of them. A move ("change reference": verse, ref_raw,
// sort_order) or a reorder (sort_order) carries none of the typed fields, so
// clearing on its 200 left the typing only in React state and the status bar
// saying "saved". Deletes, and drafts without a patch object, keep the
// earlier clear-on-200 behavior.
export function rowOpClearsDraft(
  op: Pick<OutboxOp, "action" | "patch">,
  draft: Pick<DraftRecord, "payload">,
): boolean {
  if (op.action !== "patch") return true;
  const patch = (draft.payload as { patch?: unknown }).patch;
  if (!patch || typeof patch !== "object") return true;
  const fields = Object.keys(patch);
  if (fields.length === 0) return true;
  return fields.some((field) => Object.prototype.hasOwnProperty.call(op.patch, field));
}

// A row op's draftGeneration when no draft existed for the row at enqueue
// (#1092 review). Distinct from an absent field, which marks a legacy op
// queued before row ops carried a generation.
export const NO_ROW_DRAFT = "no-draft";

// Whether the 200 handler for a row op may delete the row draft it just read
// (#1092 review). `latestAt200` is the key's latest in-memory draft generation
// when the 200 was handled, `latestNow` the same at the moment of the read;
// both are undefined in a tab that never wrote this draft (a reload after
// Save, or another tab holding the drain lock). Typing after the save (a
// keystroke while it is in flight, or NoteCard re-setting a still-dirty draft
// when the row version bumps, which runs before the 200 handler) shows up as
// a different generation or a later updatedAt, and must never be deleted.
//   - op.draftGeneration = a generation: clear only that stored generation,
//     and only while no newer set() has started in this tab.
//   - op.draftGeneration = NO_ROW_DRAFT: clear only a draft written before the
//     op was queued (a prior session's draft the save stored).
//   - no field (legacy op): fall back to the generation read at the 200.
export function rowDraftClearAfterOk(
  op: Pick<OutboxOp, "action" | "patch" | "draftGeneration" | "queuedAt">,
  latestAt200: string | undefined,
  latestNow: string | undefined,
  rec: Pick<DraftRecord, "payload" | "generation" | "updatedAt"> | undefined,
): boolean {
  if (!rec) return false;
  if (!rowOpClearsDraft(op, rec)) return false;
  const saved = op.draftGeneration;
  if (saved === NO_ROW_DRAFT) {
    return latestNow === undefined && rec.updatedAt < op.queuedAt;
  }
  if (saved !== undefined) {
    if (rec.generation !== saved) return false;
    return latestNow === undefined || latestNow === saved;
  }
  if (latestNow !== latestAt200) return false;
  if (latestAt200 !== undefined && rec.generation !== latestAt200) return false;
  return true;
}
