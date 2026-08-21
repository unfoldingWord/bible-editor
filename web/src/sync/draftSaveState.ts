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
  const generation = generationForSuccessfulOp(draft, op);
  if (generation) return { kind: "clear", generation };
  return draft ? { kind: "keep" } : { kind: "unpin" };
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
