// Unit tests for the pipeline import single-applier claim (pipelineImport.ts).
// The regression the ISA 48 incident demands: two pollers (the */5 cron and a
// translator's open tab polling GET /api/pipelines/:jobId) must never both run
// the destructive delete/insert apply for one job — their chapter-scoped TN
// deletes interleaved and wiped/doubled the chapter (2026-06-30). The
// production guard is one atomic CAS UPDATE; mayClaimImport is its predicate,
// tested here so the concurrency rule can't silently regress.
// Run from api/:
//   node --experimental-strip-types --no-warnings src/pipelineImport.test.mjs
//
// Not a test framework; a failed assert exits non-zero.

import {
  mayClaimImport,
  IMPORT_CLAIM_STALE_SECONDS,
  tnSweepScope,
  shouldTouchClaim,
  CLAIM_TOUCH_INTERVAL_SECONDS,
} from "./pipelineImportClaim.ts";
import { deleteUnkeptTns } from "./pipelineImport.ts";

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`  ok: ${msg}`);
}

const NOW = 1_000_000;

// --- Unclaimed slot: the first poller may take it ---
assert(mayClaimImport(null, NOW), "unclaimed (NULL) → may claim");

// --- The race: once a poller claims, a concurrent racer must NOT re-claim ---
// Model the atomic CAS: poller A wins and stamps import_claimed_at = NOW.
// Poller B, which read the same pre-apply state, now re-evaluates against the
// stamped value and must be refused.
const afterA = NOW; // A's claim timestamp
assert(
  !mayClaimImport(afterA, NOW),
  "fresh claim by a concurrent poller → refused (no interleaving second apply)",
);
assert(
  !mayClaimImport(afterA, NOW + 1),
  "claim 1s old → still refused",
);
assert(
  !mayClaimImport(afterA, NOW + IMPORT_CLAIM_STALE_SECONDS),
  "claim exactly at the stale window → still held (strictly-less-than)",
);

// --- Crash recovery: a claim left dangling by a hard Worker death (no JS
//     throw to release it) becomes reclaimable once older than the window ---
assert(
  mayClaimImport(afterA, NOW + IMPORT_CLAIM_STALE_SECONDS + 1),
  "claim older than the stale window → reclaimable (crash recovery)",
);

// --- Release path: a failed apply sets import_claimed_at back to NULL, so the
//     one-retry poll can immediately re-import ---
assert(
  mayClaimImport(null, NOW + 5),
  "released claim (NULL) → immediately reclaimable for the retry",
);

// --- The stale window is a lease bound for CRASH RECOVERY, not a promise that
//     it exceeds any real apply. DAN 11's apply ran ~12 minutes — longer than
//     IMPORT_CLAIM_STALE_SECONDS (600s) — so a long-but-alive apply is only
//     protected because it heartbeats its claim (see shouldTouchClaim below).
//     The invariant that actually matters is the RELATIONSHIP between the two
//     constants: the heartbeat must fire often enough, relative to the lease,
//     to keep it alive comfortably — a heartbeat slower than (or even close
//     to) the lease window cannot reliably keep a live claim from going stale
//     between touches. ---
assert(
  CLAIM_TOUCH_INTERVAL_SECONDS * 2 <= IMPORT_CLAIM_STALE_SECONDS,
  `heartbeat interval (${CLAIM_TOUCH_INTERVAL_SECONDS}s) must be comfortably under the stale window ` +
    `(${IMPORT_CLAIM_STALE_SECONDS}s, at least 2x margin) — a heartbeat slower than the lease cannot keep it alive`,
);

// ── tnSweepScope: the DAN 11 regression ──────────────────────────────────
// A resumed apply only re-selects UNRESOLVED proposals. Scoping the TN delete
// sweep to those proposals' (chapter, verse) pairs (rather than to every verse
// the job ever proposed for) means a verse the FIRST pass already applied and
// resolved must NOT reappear in the sweep scope for the resumed pass.
{
  // DAN 11 tn, en_tn, 2026-08-03: first pass proposed/applied verses 1-31 (and
  // more), died before resolving verses 32-45; the resumed pass's unresolved
  // proposals are ONLY verses 32-45. The regression: a job-wide scope would
  // include 1-31 and delete the first pass's already-applied notes.
  const resumedUnresolved = [];
  for (let v = 32; v <= 45; v++) resumedUnresolved.push({ chapter: 11, verse: v });
  const scope = tnSweepScope(resumedUnresolved);
  const verses = new Set(scope.map((p) => `${p.chapter}/${p.verse}`));
  assert(
    scope.length === 14,
    "DAN 11 regression: resumed-pass scope has exactly the 14 unresolved verses",
  );
  for (let v = 1; v <= 31; v++) {
    assert(
      !verses.has(`11/${v}`),
      `DAN 11 regression: ch11 v${v} (first pass's already-applied verse) absent from resumed scope`,
    );
  }
  assert(verses.has("11/32") && verses.has("11/45"), "DAN 11 regression: unresolved verses present");
}

// --- dedupes multiple proposals sharing one verse ---
assert(
  tnSweepScope([
    { chapter: 3, verse: 5 },
    { chapter: 3, verse: 5 },
    { chapter: 3, verse: 5 },
  ]).length === 1,
  "tnSweepScope dedupes multiple proposals for the same verse",
);

// --- keeps (chapter, verse) pairs distinct across chapters ---
{
  const scope = tnSweepScope([{ chapter: 2, verse: 1 }]);
  assert(
    scope.length === 1 && scope[0].chapter === 2 && scope[0].verse === 1,
    "tnSweepScope: a proposal for ch2 v1 does not also put ch1 v1 in scope",
  );
}

// --- empty input → empty scope ---
assert(tnSweepScope([]).length === 0, "tnSweepScope([]) → empty scope");

// ── shouldTouchClaim: heartbeat rate limit ──────────────────────────────
assert(
  !shouldTouchClaim(NOW, NOW + CLAIM_TOUCH_INTERVAL_SECONDS - 1),
  "shouldTouchClaim: below the interval → false",
);
assert(
  shouldTouchClaim(NOW, NOW + CLAIM_TOUCH_INTERVAL_SECONDS),
  "shouldTouchClaim: exactly at the interval → true",
);
assert(
  shouldTouchClaim(NOW, NOW + CLAIM_TOUCH_INTERVAL_SECONDS + 1),
  "shouldTouchClaim: after the interval → true",
);
{
  // A long apply (DAN 11: ~12 minutes) gets its claim refreshed repeatedly,
  // not just once, as long as the caller re-checks each time it last touched.
  let lastTouchedAt = NOW;
  let touches = 0;
  for (let elapsed = 0; elapsed <= 12 * 60; elapsed += 5) {
    const now = NOW + elapsed;
    if (shouldTouchClaim(lastTouchedAt, now)) {
      touches += 1;
      lastTouchedAt = now;
    }
  }
  assert(
    touches >= 10,
    `shouldTouchClaim: a 12-minute apply refreshes its claim repeatedly (${touches} touches)`,
  );
}

// ── deleteUnkeptTns: the SQL it actually generates (fake-DB) ─────────────
// tnSweepScope alone only proves a pure helper doesn't invent inputs — the
// real DAN 11 regression lived in the SQL deleteUnkeptTns builds. Reverting
// that SQL to the old job-wide `EXISTS (... pending_imports ...)` while
// leaving tnSweepScope exported-but-unused would pass every assertion above.
// These tests call the REAL deleteUnkeptTns against a fake env.DB that
// records every prepared statement's SQL text and bound args, so they fail if
// the generated query stops matching what we intend.
//
// Fake DB: prepare(sql).bind(...args) records the call and returns an object
// whose .all()/.run() answer with empty result shapes. deleteUnkeptTns's
// SELECT loop always sees zero live rows back, so it returns 0 without ever
// reaching the delete-execution phase (env.DB.batch is never called) — exactly
// the surface these tests need: the SELECT's SQL and bindings.
function fakeDeleteDb() {
  const calls = [];
  return {
    calls,
    env: {
      DB: {
        prepare(sql) {
          return {
            bind(...args) {
              calls.push({ sql, args });
              return {
                async all() {
                  return { results: [] };
                },
                async run() {
                  return { meta: { changes: 0 } };
                },
              };
            },
          };
        },
        async batch(stmts) {
          throw new Error(
            `unexpected env.DB.batch call with ${stmts.length} statements — ` +
              "the fake SELECT always returns zero rows, so deleteUnkeptTns should " +
              "return before ever building a delete batch",
          );
        },
      },
    },
  };
}

// tnProposals only needs (chapter, verse) for tnSweepScope's purposes here;
// the rest of PendingImportRow is irrelevant to deleteUnkeptTns.
function tnProposal(chapter, verse) {
  return {
    id: chapter * 100000 + verse,
    kind: "tn",
    book: "DAN",
    chapter,
    verse,
    bible_version: null,
    payload_json: "{}",
  };
}

function selectCalls(calls) {
  return calls.filter((c) => /SELECT id, version FROM tn_rows/.test(c.sql));
}

function pairsFromArgs(args) {
  // args = [book, startChapter, endChapter, AI_SOURCE, ch1, v1, ch2, v2, ...]
  const pairs = [];
  for (let i = 4; i < args.length; i += 2) {
    pairs.push({ chapter: args[i], verse: args[i + 1] });
  }
  return pairs;
}

const job11 = {
  jobId: "job-dan11",
  pipelineType: "notes",
  book: "DAN",
  startChapter: 11,
  endChapter: 11,
};
const newHeartbeat = () => ({ lastTouchedAt: Math.floor(Date.now() / 1000) });

// --- Test 1: the DAN 11 regression, against the REAL generated SQL ---
await (async () => {
  const proposals = [];
  for (let v = 32; v <= 45; v++) proposals.push(tnProposal(11, v));
  const { calls, env } = fakeDeleteDb();
  await deleteUnkeptTns(env, job11, 1, proposals, newHeartbeat());

  const sels = selectCalls(calls);
  assert(sels.length > 0, "DAN 11 SQL regression: deleteUnkeptTns issued at least one SELECT");

  for (const c of sels) {
    assert(
      !/pending_imports/.test(c.sql),
      "DAN 11 SQL regression: generated SQL does NOT reference pending_imports " +
        "(the job-wide EXISTS subquery is exactly what deleted the first pass's notes)",
    );
  }

  const coveredPairs = new Set();
  for (const c of sels) {
    for (const p of pairsFromArgs(c.args)) coveredPairs.add(`${p.chapter}/${p.verse}`);
  }
  for (let v = 32; v <= 45; v++) {
    assert(
      coveredPairs.has(`11/${v}`),
      `DAN 11 SQL regression: bound pair for ch11 v${v} present in generated SQL`,
    );
  }
  assert(
    coveredPairs.size === 14,
    `DAN 11 SQL regression: exactly 14 bound pairs generated (got ${coveredPairs.size})`,
  );
})();

// --- Test 2: every existing safety guard still appears in the generated SQL ---
await (async () => {
  const proposals = [tnProposal(11, 32)];
  const { calls, env } = fakeDeleteDb();
  await deleteUnkeptTns(env, job11, 1, proposals, newHeartbeat());

  const sels = selectCalls(calls);
  assert(sels.length > 0, "guard-preservation: at least one SELECT issued");
  const sql = sels[0].sql;
  for (const guard of [
    "deleted_at IS NULL",
    "trashed_at IS NULL",
    "preserve = 0",
    "hint = 0",
    "chapter BETWEEN",
    "updated_by IS NULL",
  ]) {
    assert(sql.includes(guard), `guard-preservation: generated SQL retains "${guard}"`);
  }
  assert(
    /FROM edit_log/.test(sql) && /action IN \('create', 'update'\)/.test(sql),
    "guard-preservation: generated SQL retains the edit_log latest-content-source subquery",
  );
})();

// --- Test 3: binding integrity across multiple chunks ---
await (async () => {
  // 95 unresolved verses forces 3 chunks at CHUNK_PAIRS=40 (40 + 40 + 15).
  const inputPairs = [];
  for (let v = 1; v <= 95; v++) inputPairs.push({ chapter: 11, verse: v });
  const proposals = inputPairs.map((p) => tnProposal(p.chapter, p.verse));
  const { calls, env } = fakeDeleteDb();
  await deleteUnkeptTns(env, job11, 1, proposals, newHeartbeat());

  const sels = selectCalls(calls);
  assert(
    sels.length >= 3,
    `binding integrity: 95 verses forces multiple chunked statements (got ${sels.length})`,
  );

  const seenPairKeys = [];
  for (const c of sels) {
    // Every ?N placeholder in the SQL must have a bound argument at that
    // position, and the statement must never exceed D1's ~100-param cap.
    const placeholderNumbers = [...c.sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
    const maxPlaceholder = Math.max(...placeholderNumbers);
    assert(
      maxPlaceholder === c.args.length,
      `binding integrity: highest placeholder ?${maxPlaceholder} has a bound arg ` +
        `(${c.args.length} args bound)`,
    );
    assert(
      c.args.length <= 100,
      `binding integrity: statement binds ${c.args.length} params, within D1's 100-param cap`,
    );
    for (const p of pairsFromArgs(c.args)) seenPairKeys.push(`${p.chapter}/${p.verse}`);
  }

  const inputKeys = inputPairs.map((p) => `${p.chapter}/${p.verse}`);
  assert(
    seenPairKeys.length === inputKeys.length,
    `binding integrity: no duplicate/omitted pairs across chunks ` +
      `(expected ${inputKeys.length}, got ${seenPairKeys.length})`,
  );
  const seenSet = new Set(seenPairKeys);
  assert(
    inputKeys.every((k) => seenSet.has(k)),
    "binding integrity: union of bound pairs across all statements equals the input pairs exactly",
  );
});

console.log("pipelineImport (claim guard): all assertions passed");
