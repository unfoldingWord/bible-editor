// The dispatch half of POST /books/:book/lock/push (bookImport.ts), pulled out
// so it can be tested against a fake EXPORT_WORKFLOW (lockPush.test.mjs) with
// no route harness and no real export.
//
// Issue #1406: the admin picks which resources to push. This creates one export
// instance for each chosen resource, once each, and nothing for the rest.
import { lockPushExportParams, type Resource } from "./export.ts";

export type LockPushResult = { resource: Resource; instanceId: string } | { resource: Resource; error: string };

interface ExportWorkflowLike {
  create(opts: { id: string; params: ReturnType<typeof lockPushExportParams> }): Promise<{ id: string }>;
}

export async function dispatchLockPush(
  workflow: ExportWorkflowLike,
  opts: { book: string; resources: readonly Resource[]; branchName?: string; stamp: string },
): Promise<LockPushResult[]> {
  const { book, branchName, stamp } = opts;
  // Each resource lives in its own DCS repo (RESOURCE_TARGETS in export.ts), so
  // the creates share no mutable state and can run concurrently. Deduped so a
  // repeated name in the body cannot start two exports of the same repo.
  const resources = [...new Set(opts.resources)];
  return Promise.all(
    resources.map(async (resource): Promise<LockPushResult> => {
      try {
        const instance = await workflow.create({
          id: `lock-push-${book}-${resource}-${stamp}`,
          // See lockPushExportParams in export.ts for why staging must turn
          // validateAndMerge off, and for the test that pins it.
          params: lockPushExportParams(book, resource, branchName),
        });
        return { resource, instanceId: instance.id };
      } catch (e) {
        return { resource, error: e instanceof Error ? e.message : String(e) };
      }
    }),
  );
}

// The `reason` for the lock_push audit row (book_lock_events). Names which
// resources were dispatched and which failed, since a push is no longer always
// all five. Records WHICH intent ran too: "did this go straight to master or
// wait for review?" is the first question asked of a published book afterwards.
// "staged on X" only when something dispatched; at 0 nothing was staged
// anywhere, and the audit row is the one place a later investigator cannot check.
// Free text: nothing parses it.
export function lockPushAuditReason(pushed: readonly LockPushResult[], branchName?: string): string {
  const ok = pushed.filter((p) => "instanceId" in p).map((p) => p.resource);
  const failed = pushed.filter((p) => !("instanceId" in p)).map((p) => p.resource);
  const detail = `(${ok.join(", ") || "none"}${failed.length ? `; failed: ${failed.join(", ")}` : ""})`;
  const base = `dispatched ${ok.length}/${pushed.length} ${detail}`;
  if (!branchName) return base;
  return ok.length > 0 ? `${base} staged on ${branchName}` : `${base} (intended to stage on ${branchName})`;
}
