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
  shouldAbortApply,
  shouldCheckCancel,
  CANCEL_CHECK_INTERVAL_SECONDS,
} from "./pipelineImportClaim.ts";
import {
  deleteUnkeptTns,
  importJobOutput,
  maybeTouchClaim,
  maybeCheckCancelled,
  tnPayload,
  tqPayload,
} from "./pipelineImport.ts";
import { ROW_ID_RE, coerceRowId, deriveAltRowId } from "./rowId.ts";

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
  const scope = tnSweepScope(resumedUnresolved, []);
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
  tnSweepScope(
    [
      { chapter: 3, verse: 5 },
      { chapter: 3, verse: 5 },
      { chapter: 3, verse: 5 },
    ],
    [],
  ).length === 1,
  "tnSweepScope dedupes multiple proposals for the same verse",
);

// --- keeps (chapter, verse) pairs distinct across chapters ---
{
  const scope = tnSweepScope([{ chapter: 2, verse: 1 }], []);
  assert(
    scope.length === 1 && scope[0].chapter === 2 && scope[0].verse === 1,
    "tnSweepScope: a proposal for ch2 v1 does not also put ch1 v1 in scope",
  );
}

// --- empty input → empty scope ---
assert(tnSweepScope([], []).length === 0, "tnSweepScope([], []) → empty scope");

// ── tnSweepScope: exclude verses that already have accepted proposals ────
// Codex review flagged the straddled-verse gap: scoping by unresolved
// proposals alone still re-sweeps a verse a PRIOR pass already accepted some
// proposals for, destroying that pass's already-applied work. A verse with an
// accepted proposal for this job must be excluded entirely, regardless of
// whether it also still has unresolved proposals.
{
  const proposals = [
    { chapter: 11, verse: 5 },
    { chapter: 11, verse: 6 },
    { chapter: 11, verse: 7 },
  ];
  const resolvedPairs = [{ chapter: 11, verse: 5 }];
  const scope = tnSweepScope(proposals, resolvedPairs);
  const verses = new Set(scope.map((p) => `${p.chapter}/${p.verse}`));
  assert(
    !verses.has("11/5"),
    "tnSweepScope: a verse with an accepted proposal is excluded from scope even though it also has unresolved proposals",
  );
  assert(
    verses.has("11/6") && verses.has("11/7"),
    "tnSweepScope: verses without accepted proposals remain in scope",
  );
  assert(scope.length === 2, "tnSweepScope: excluded verse is the only one dropped");
}

// --- exclusion matches (chapter, verse) exactly — a same-numbered verse in a
//     different chapter must NOT be excluded ---
{
  const proposals = [
    { chapter: 1, verse: 5 },
    { chapter: 2, verse: 5 },
  ];
  const resolvedPairs = [{ chapter: 1, verse: 5 }];
  const scope = tnSweepScope(proposals, resolvedPairs);
  const verses = new Set(scope.map((p) => `${p.chapter}/${p.verse}`));
  assert(
    !verses.has("1/5") && verses.has("2/5"),
    "tnSweepScope: exclusion matches (chapter, verse) exactly, not verse number alone",
  );
}

// --- empty resolved set behaves exactly as before (no exclusion) ---
{
  const proposals = [
    { chapter: 11, verse: 6 },
    { chapter: 11, verse: 7 },
  ];
  const scope = tnSweepScope(proposals, []);
  assert(
    scope.length === 2,
    "tnSweepScope: an empty resolved set excludes nothing (unchanged behavior)",
  );
}

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

// ── maybeTouchClaim / touchImportClaim: the heartbeat as a real CAS lease ──
// Three independent reviews flagged the original heartbeat: it re-stamped
// import_claimed_at unconditionally, so if this pass's claim went stale and
// another poller legitimately re-claimed, a late heartbeat from the original
// pass would silently steal the lease back. These tests drive the REAL
// maybeTouchClaim/touchImportClaim against a fake DB that models a single
// pipeline_jobs row's import_claimed_at in memory and evaluates the WHERE
// clause the way D1 actually would: if the generated SQL still carries the
// CAS condition (`import_claimed_at = ?2`), the UPDATE only succeeds when the
// bound expected value matches the row's CURRENT value. If the SQL doesn't
// carry that condition (the regression: an unconditional heartbeat), the fake
// honors that too — unconditionally — which is exactly the bad behavior this
// test exists to catch when someone removes the condition.
function fakeLeaseDb(initialClaimedAt) {
  const calls = [];
  const row = { import_claimed_at: initialClaimedAt };
  return {
    calls,
    setRowClaimedAt(v) {
      // Simulates another poller's CAS UPDATE succeeding in between this
      // pass's heartbeats — the row now holds a value this pass never wrote.
      row.import_claimed_at = v;
    },
    env: {
      DB: {
        prepare(sql) {
          return {
            bind(...args) {
              calls.push({ sql, args });
              return {
                async run() {
                  const hasCasCondition = /import_claimed_at\s*=\s*\?2/.test(sql);
                  const expected = args[1];
                  const matches = !hasCasCondition || row.import_claimed_at === expected;
                  if (!matches) {
                    return { meta: { changes: 0 }, results: [] };
                  }
                  row.import_claimed_at += 1; // simulate unixepoch() advancing
                  return {
                    meta: { changes: 1 },
                    results: [{ import_claimed_at: row.import_claimed_at }],
                  };
                },
              };
            },
          };
        },
      },
    },
  };
}

// --- heartbeat succeeds while still owned, and continues on later touches ---
await (async () => {
  const { calls, env } = fakeLeaseDb(1000);
  // lastTouchedAt = 0 forces shouldTouchClaim to fire regardless of real wall
  // clock time (now - 0 is always >= CLAIM_TOUCH_INTERVAL_SECONDS).
  const hb = { lastTouchedAt: 0, ownedClaimedAt: 1000, lost: false };

  await maybeTouchClaim(env, "job-lease-ok", hb);
  assert(calls.length === 1, "lease CAS: a due heartbeat issues exactly one UPDATE");
  assert(
    calls[0].args[0] === "job-lease-ok" && calls[0].args[1] === 1000,
    "lease CAS: binds the job id AND the last-known owned value",
  );
  assert(hb.ownedClaimedAt === 1001, "lease CAS: stored owned value advances to the row's new value");
  assert(hb.lost === false, "lease CAS: not marked lost on success");

  hb.lastTouchedAt = 0; // simulate the interval elapsing again
  await maybeTouchClaim(env, "job-lease-ok", hb);
  assert(calls.length === 2, "lease CAS: a second due heartbeat issues another UPDATE");
  assert(
    calls[1].args[1] === 1001,
    "lease CAS: the second heartbeat CASes against the UPDATED owned value, not the original",
  );
  assert(hb.ownedClaimedAt === 1002, "lease CAS: stored owned value advances again");
})();

// --- lease takeover: another poller re-claims between heartbeats ---
await (async () => {
  const { calls, env, setRowClaimedAt } = fakeLeaseDb(2000);
  const hb = { lastTouchedAt: 0, ownedClaimedAt: 2000, lost: false };
  // Another poller's claim won the CAS in importJobOutput while this pass was
  // stalled — the row no longer holds what this pass believes it owns.
  setRowClaimedAt(9999);

  const originalConsoleError = console.error;
  let loggedArgs = null;
  console.error = (...args) => {
    loggedArgs = args;
  };
  try {
    await maybeTouchClaim(env, "job-lease-stolen", hb);
  } finally {
    console.error = originalConsoleError;
  }
  assert(calls.length === 1, "lease takeover: the failed CAS still issues exactly one UPDATE attempt");
  assert(hb.lost === true, "lease takeover: hb.lost is set once the CAS fails");
  assert(
    loggedArgs != null && /lease lost/i.test(String(loggedArgs[0])),
    "lease takeover: logs the loss via console.error",
  );

  // The regression that matters: no further heartbeat UPDATEs after the lease
  // is lost, however much time passes.
  hb.lastTouchedAt = 0;
  await maybeTouchClaim(env, "job-lease-stolen", hb);
  assert(
    calls.length === 1,
    "lease takeover: no further heartbeat UPDATEs are issued once the lease is lost",
  );
})();

// --- binding integrity: the conditional UPDATE binds the last-known value,
//     not just the job id, and the generated SQL retains the CAS condition ---
await (async () => {
  const { calls, env } = fakeLeaseDb(500);
  const hb = { lastTouchedAt: 0, ownedClaimedAt: 500, lost: false };
  await maybeTouchClaim(env, "job-lease-bind", hb);
  assert(calls.length === 1, "lease CAS binding: one UPDATE issued");
  assert(
    calls[0].args.length === 2,
    "lease CAS binding: exactly 2 args bound (job id + expected owned value)",
  );
  assert(
    calls[0].args[1] === 500,
    "lease CAS binding: the second bound arg is the last-known owned value",
  );
  assert(
    /AND\s+import_claimed_at\s*=\s*\?2/.test(calls[0].sql),
    "lease CAS binding: generated SQL retains the CAS condition (AND import_claimed_at = ?2)",
  );
})();

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
// whose .all()/.run() answer with empty result shapes, EXCEPT the
// `pending_imports` resolved-pairs lookup deleteUnkeptTns issues first (see
// its `SELECT DISTINCT chapter, verse FROM pending_imports ... accepted_at IS
// NOT NULL` query) — that one answers with `resolvedRows` so tests can
// exercise the accepted-proposal exclusion. The tn_rows target SELECT always
// sees zero live rows back, so deleteUnkeptTns returns 0 without ever
// reaching the delete-execution phase (env.DB.batch is never called) —
// exactly the surface these tests need: the SELECT's SQL and bindings.
function fakeDeleteDb(resolvedRows = []) {
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
                  if (/FROM pending_imports/.test(sql)) {
                    return { results: resolvedRows };
                  }
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
const newHeartbeat = () => ({
  lastTouchedAt: Math.floor(Date.now() / 1000),
  ownedClaimedAt: Math.floor(Date.now() / 1000),
  lost: false,
});

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

// --- Test 2b: Codex finding — a verse with an accepted proposal must be
//     excluded from the sweep scope entirely, even though the job also has
//     unresolved proposals for other verses. Against the REAL deleteUnkeptTns
//     + the real pending_imports resolved-pairs query, not just the pure
//     tnSweepScope helper. ---
await (async () => {
  // The straddled-verse shape this closes: ch11 v5 had 3 proposals, one of
  // which got accepted before the process died, leaving a 2nd unresolved
  // proposal for the SAME verse still in tnProposals (that's what
  // applyJobOutput's accepted_at IS NULL SELECT hands to deleteUnkeptTns) —
  // v5 must still be excluded even though it also has an unresolved proposal
  // here. v6/v7 have no accepted proposals at all, so they stay in scope.
  const proposals = [tnProposal(11, 5), tnProposal(11, 6), tnProposal(11, 7)];
  const resolvedRows = [{ chapter: 11, verse: 5 }];
  const { calls, env } = fakeDeleteDb(resolvedRows);
  await deleteUnkeptTns(env, job11, 1, proposals, newHeartbeat());

  const sels = selectCalls(calls);
  assert(sels.length > 0, "Codex straddled-verse fix: at least one target SELECT issued");

  const boundPairs = new Set();
  for (const c of sels) {
    for (const p of pairsFromArgs(c.args)) boundPairs.add(`${p.chapter}/${p.verse}`);
  }
  assert(
    !boundPairs.has("11/5"),
    "Codex straddled-verse fix: ch11 v5 (has an accepted proposal) is ABSENT from bound pairs",
  );
  assert(
    boundPairs.has("11/6") && boundPairs.has("11/7"),
    "Codex straddled-verse fix: ch11 v6 and v7 (unresolved, no accepted proposal) are bound",
  );
  assert(boundPairs.size === 2, `Codex straddled-verse fix: exactly 2 verses bound (got ${boundPairs.size})`);
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

// --- error-path release is CAS'd too: a pass that already lost the lease must
//     NOT null out the new owner's claim when it later throws ---
// Same class as the heartbeat bug: the heartbeat was made a compare-and-swap
// lease, but the catch-path release in importJobOutput was still blind. A pass
// whose lease was stolen and which then throws for any unrelated reason would
// clear the NEW owner's claim mid-apply, letting a third poller claim and
// interleave. Driven end-to-end through importJobOutput by making the first
// staging read throw.
await (async () => {
  const calls = [];
  const row = { import_claimed_at: null };
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            calls.push({ sql, args });
            const fail = () => {
              // stageJobOutput's first read — throw so we land in the catch.
              if (/SELECT staged_at/.test(sql)) throw new Error("simulated staging failure");
            };
            return {
              async first() {
                fail();
                return null;
              },
              async all() {
                fail();
                return { results: [] };
              },
              async run() {
                fail();
                // The initial claim: CAS on the staleness window, not on a value.
                if (/import_claimed_at\s*=\s*unixepoch\(\)/.test(sql) && /IS NULL OR/.test(sql)) {
                  row.import_claimed_at = 5000;
                  return { meta: { changes: 1 }, results: [{ import_claimed_at: 5000 }] };
                }
                return { meta: { changes: 0 }, results: [] };
              },
            };
          },
        };
      },
    },
  };

  let threw = false;
  try {
    await importJobOutput(env, { jobId: "job-release", book: "DAN", startChapter: 11, endChapter: 11, userId: 2 }, []);
  } catch {
    threw = true;
  }
  assert(threw, "error-path release: the underlying failure still propagates to the caller");

  const release = calls.find((c) => /import_claimed_at\s*=\s*NULL/.test(c.sql));
  assert(release !== undefined, "error-path release: a release UPDATE is issued on failure");
  assert(
    /AND import_claimed_at\s*=\s*\?2/.test(release.sql),
    "error-path release: the release is CAS'd on the owned claim, not a blind job_id-only NULL",
  );
  assert(
    release.args[0] === "job-release" && release.args[1] === 5000,
    "error-path release: binds the job id AND the exact claim value this pass owned (from RETURNING)",
  );
})();

// ── #402: mid-apply cancellation ─────────────────────────────────────────
// A terminal transition (force-stop, cancel, or the no-progress 'interrupted'
// sentinel) landing WHILE importJobOutput is mid-apply used to have no
// cancellation point at all — the apply just ran to completion regardless.
// These tests cover the pure predicate (shouldAbortApply), the rate-limited
// checker (maybeCheckCancelled), and the real end-to-end apply loop stopping
// at a batch boundary with keep-and-record semantics.

// --- shouldAbortApply (two-arg): DELIBERATE stops abort; timer sentinels and
//     this import's own retry path must NOT. Getting either of these
//     backwards is worse than the bug #402 fixes: it PERMANENTLY discards a
//     completed AI run's output (see the long comment on shouldAbortApply). ---
assert(
  shouldAbortApply("failed", "interrupted") === false,
  "shouldAbortApply('failed','interrupted') -> false — the 48h/attempt-exhausted/stuck-dispatch " +
    "timer sentinel must NEVER abort an apply: it fires on healthy, actively-progressing jobs " +
    "(see FIX 2b) and there is no resume path once an apply aborts",
);
assert(
  shouldAbortApply("failed", "import_failed") === false,
  "shouldAbortApply('failed','import_failed') -> false — that is THIS import's own one-retry " +
    "path; aborting on it would make the retry impossible",
);
assert(
  shouldAbortApply("failed", "force_stopped") === true,
  "shouldAbortApply('failed','force_stopped') -> true — a human deliberately force-stopped the job",
);
assert(
  shouldAbortApply("cancelled", null) === true,
  "shouldAbortApply('cancelled', null) -> true — a user deliberately cancelled the run",
);
assert(
  shouldAbortApply("done", null) === false,
  "shouldAbortApply('done', null) -> false — a second poll writing state='done' without importing " +
    "(e.g. an empty output[] short-circuit) must NOT abort a healthy in-flight apply; the CAS import " +
    "claim already prevents two concurrent applies, so 'done' buys nothing as a stop signal and would " +
    "only strand the live apply's remaining proposals with no retry path",
);
for (const [state, errorKind] of [
  ["running", null],
  ["paused_for_outage", null],
  ["paused_for_usage_limit", null],
  ["queued", null],
  ["dispatching", null],
  ["done", null],
  [null, null],
  ["", null],
  [undefined, undefined],
]) {
  assert(
    shouldAbortApply(state, errorKind) === false,
    `shouldAbortApply(${JSON.stringify(state)}, ${JSON.stringify(errorKind)}) -> false ` +
      "(not a deliberate stop)",
  );
}

// --- shouldAbortApply: the load-bearing invariant — a failed/missing read
//     must NEVER be mistaken for "abort". Getting this backwards would abort
//     a perfectly healthy in-flight apply on a transient read glitch. ---
assert(
  shouldAbortApply(null, null) === false,
  "shouldAbortApply(null, null) -> false — a failed/missing state read must NOT be treated as an abort signal",
);
assert(
  shouldAbortApply(undefined, undefined) === false,
  "shouldAbortApply(undefined, undefined) -> false — same invariant as null",
);
assert(
  shouldAbortApply("", null) === false,
  "shouldAbortApply('', null) -> false — same invariant as null/undefined",
);

// ── shouldCheckCancel: rate limit, mirroring shouldTouchClaim's tests ────
assert(
  !shouldCheckCancel(NOW, NOW + CANCEL_CHECK_INTERVAL_SECONDS - 1),
  "shouldCheckCancel: below the interval → false",
);
assert(
  shouldCheckCancel(NOW, NOW + CANCEL_CHECK_INTERVAL_SECONDS),
  "shouldCheckCancel: exactly at the interval → true",
);
assert(
  shouldCheckCancel(NOW, NOW + CANCEL_CHECK_INTERVAL_SECONDS + 1),
  "shouldCheckCancel: after the interval → true",
);
assert(
  CANCEL_CHECK_INTERVAL_SECONDS < CLAIM_TOUCH_INTERVAL_SECONDS,
  `cancel check interval (${CANCEL_CHECK_INTERVAL_SECONDS}s) must be tighter than the heartbeat interval ` +
    `(${CLAIM_TOUCH_INTERVAL_SECONDS}s) — this is a responsiveness bound on how long an apply keeps writing ` +
    "after a human force-stops it, not a lease-staleness window",
);

// ── maybeCheckCancelled: direct fake-DB harness ──────────────────────────
// Drives the real maybeCheckCancelled against a fake pipeline_jobs SELECT that
// answers with a queue of rows (or a missing row when the queue is empty).
function fakeCancelDb(rowsQueue) {
  const calls = [];
  const queue = [...rowsQueue];
  return {
    calls,
    env: {
      DB: {
        prepare(sql) {
          return {
            bind(...args) {
              calls.push({ sql, args });
              return {
                async first() {
                  return queue.length > 0 ? queue.shift() : null;
                },
              };
            },
          };
        },
      },
    },
  };
}

// --- (a) does NOT read when inside the check interval ---
await (async () => {
  const { calls, env } = fakeCancelDb([{ state: "running", error_kind: null }]);
  const cw = {
    lastCheckedAt: Math.floor(Date.now() / 1000),
    aborted: false,
    abortState: null,
    abortErrorKind: null,
  };
  const result = await maybeCheckCancelled(env, "job-cancel-a", cw);
  assert(result === false, "maybeCheckCancelled: false when not yet aborted and inside the check interval");
  assert(calls.length === 0, "maybeCheckCancelled: no DB read issued while inside the check interval");
})();

// --- (b) aborts on a failed/force_stopped row, (c) short-circuits after ---
await (async () => {
  const { calls, env } = fakeCancelDb([{ state: "failed", error_kind: "force_stopped" }]);
  const cw = { lastCheckedAt: 0, aborted: false, abortState: null, abortErrorKind: null };
  const originalConsoleError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await maybeCheckCancelled(env, "job-cancel-b", cw);
  } finally {
    console.error = originalConsoleError;
  }
  assert(result === true, "maybeCheckCancelled: true on a terminal (failed/force_stopped) row");
  assert(calls.length === 1, "maybeCheckCancelled: exactly one SELECT issued when due");
  assert(cw.aborted === true, "maybeCheckCancelled: cw.aborted set on a terminal row");
  assert(cw.abortState === "failed", "maybeCheckCancelled: cw.abortState captured from the row");
  assert(cw.abortErrorKind === "force_stopped", "maybeCheckCancelled: cw.abortErrorKind captured from the row");

  // (c) once aborted, later calls return true WITHOUT re-reading — even if
  // the rate limit would otherwise allow another read.
  cw.lastCheckedAt = 0;
  const result2 = await maybeCheckCancelled(env, "job-cancel-b", cw);
  assert(result2 === true, "maybeCheckCancelled: still true once already aborted");
  assert(calls.length === 1, "maybeCheckCancelled: no additional DB read once aborted (no re-check needed)");
})();

// --- (d) a missing pipeline_jobs row does not abort ---
await (async () => {
  const { env } = fakeCancelDb([]); // empty queue → first() returns null
  const cw = { lastCheckedAt: 0, aborted: false, abortState: null, abortErrorKind: null };
  const result = await maybeCheckCancelled(env, "job-cancel-d", cw);
  assert(result === false, "maybeCheckCancelled: a missing pipeline_jobs row does not abort");
  assert(cw.aborted === false, "maybeCheckCancelled: cw.aborted stays false on a missing row");
})();

// --- (e) FIX C: a throwing SELECT must NOT fail the apply. Before this PR the
//     apply issued no such read at all; a transient D1 read error mid-apply
//     must not throw out of maybeCheckCancelled — that would propagate out of
//     applyJobOutput/stageJobOutput and release the import claim, discarding
//     a completed run. Matches shouldAbortApply's own null-safety intent: a
//     failed read is not evidence the job went terminal. ---
function fakeThrowingCancelDb() {
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
                async first() {
                  throw new Error("simulated transient D1 read failure");
                },
              };
            },
          };
        },
      },
    },
  };
}
await (async () => {
  const { calls, env } = fakeThrowingCancelDb();
  const cw = { lastCheckedAt: 0, aborted: false, abortState: null, abortErrorKind: null };
  const originalConsoleError = console.error;
  let loggedThrow = false;
  console.error = (...args) => {
    if (args.join(" ").includes("cancellation check read failed")) loggedThrow = true;
  };
  let result;
  try {
    result = await maybeCheckCancelled(env, "job-cancel-throw", cw);
  } finally {
    console.error = originalConsoleError;
  }
  assert(result === false, "maybeCheckCancelled: a throwing SELECT resolves to false, not a thrown error");
  assert(cw.aborted === false, "maybeCheckCancelled: cw.aborted stays false when the read throws");
  assert(calls.length === 1, "maybeCheckCancelled: the SELECT was actually attempted (not skipped)");
  assert(loggedThrow, "maybeCheckCancelled: logs that the cancellation check read failed");
})();

// ── End-to-end: importJobOutput stops an in-flight apply at a batch
//    boundary, keep-and-record (#402) ────────────────────────────────────
//
// Drives the REAL importJobOutput → stageJobOutput/applyJobOutput against a
// fake env.DB that: (1) reports the job as already-staged (so staging
// short-circuits and the test exercises the apply loop's checkpoints), (2)
// hands back 3 unresolved TN proposals, (3) flips pipeline_jobs.state to
// 'failed'/'force_stopped' after the Nth proposal's pending_imports accept
// commits (or never, for the not-over-eager test).
//
// maybeCheckCancelled/maybeTouchClaim are both rate-limited against the real
// wall clock (Date.now()), so the test mocks Date.now() to advance by 16s on
// every call — comfortably past both CANCEL_CHECK_INTERVAL_SECONDS (15s) and
// CLAIM_TOUCH_INTERVAL_SECONDS (60s after a few calls) — so every checkpoint
// in the loop actually reads instead of being rate-limited away within the
// same real-world millisecond the test runs in.
async function withMockedClock(fn) {
  const originalNow = Date.now;
  let t = 1_700_000_000_000;
  Date.now = () => {
    t += 16_000;
    return t;
  };
  try {
    return await fn();
  } finally {
    Date.now = originalNow;
  }
}

function buildFakeAbortDb(flipAfterProposals, opts = {}) {
  const { seedTnDeleteRows = [], throwOnStateRead = false } = opts;
  const calls = [];
  const batches = [];
  const pipelineState = { state: "running", errorKind: null };
  const dbState = { claimedAt: 1000 };
  let appliedProposalCount = 0;
  let tnInsertCount = 0;
  let tnDeleteUpdateCount = 0;
  const abortSummaryCalls = [];
  const releaseCalls = [];

  const unresolvedProposals = [
    { id: 1, kind: "tn", book: "GEN", chapter: 1, verse: 1, bible_version: null, payload_json: "{}" },
    { id: 2, kind: "tn", book: "GEN", chapter: 1, verse: 2, bible_version: null, payload_json: "{}" },
    { id: 3, kind: "tn", book: "GEN", chapter: 1, verse: 3, bible_version: null, payload_json: "{}" },
  ];

  function dispatch(sql, args) {
    if (/UPDATE pipeline_jobs SET import_claimed_at = unixepoch\(\)/.test(sql) && /IS NULL OR/.test(sql)) {
      // Initial single-applier claim.
      return {
        changes: 1,
        rows: [{ import_claimed_at: dbState.claimedAt }],
        single: { import_claimed_at: dbState.claimedAt },
      };
    }
    if (/UPDATE pipeline_jobs SET import_claimed_at = unixepoch\(\)/.test(sql) && /import_claimed_at\s*=\s*\?2/.test(sql)) {
      // Heartbeat CAS re-stamp.
      const expected = args[1];
      if (dbState.claimedAt !== expected) return { changes: 0, rows: [], single: null };
      dbState.claimedAt += 1;
      return {
        changes: 1,
        rows: [{ import_claimed_at: dbState.claimedAt }],
        single: { import_claimed_at: dbState.claimedAt },
      };
    }
    if (/SELECT staged_at FROM pipeline_jobs/.test(sql)) {
      // Already staged — stageJobOutput short-circuits so the test exercises
      // the apply loop's checkpoints specifically.
      return { changes: 0, rows: [], single: { staged_at: 999999 } };
    }
    if (/SELECT state, error_kind FROM pipeline_jobs/.test(sql)) {
      if (throwOnStateRead) throw new Error("simulated transient D1 read failure");
      return {
        changes: 0,
        rows: [],
        single: { state: pipelineState.state, error_kind: pipelineState.errorKind },
      };
    }
    if (/SELECT user_id FROM pipeline_jobs/.test(sql)) {
      return { changes: 0, rows: [], single: { user_id: 1 } };
    }
    if (/ORDER BY kind, chapter, verse, id/.test(sql)) {
      return { changes: 0, rows: unresolvedProposals, single: null };
    }
    if (/SELECT DISTINCT chapter, verse FROM pending_imports/.test(sql)) {
      return { changes: 0, rows: [], single: null }; // no accepted TN proposals yet
    }
    if (/SELECT id, version FROM tn_rows t/.test(sql)) {
      return { changes: 0, rows: seedTnDeleteRows, single: null };
    }
    if (/UPDATE tn_rows\s+SET deleted_at/.test(sql)) {
      tnDeleteUpdateCount += 1;
      return { changes: 1, rows: [], single: null };
    }
    if (/MAX\(sort_order\)/.test(sql)) {
      return { changes: 0, rows: [], single: null };
    }
    if (/occurrence, support_reference, quote, note/.test(sql)) {
      return { changes: 0, rows: [], single: null }; // content-dedup claim set: empty
    }
    if (/INSERT INTO tn_rows/.test(sql)) {
      tnInsertCount += 1;
      return { changes: 1, rows: [], single: null };
    }
    if (/INSERT INTO edit_log/.test(sql)) {
      return { changes: 1, rows: [], single: null };
    }
    if (/SET accepted_at = unixepoch\(\), accepted_by = \?2/.test(sql) && !sql.includes("EXISTS")) {
      appliedProposalCount += 1;
      if (flipAfterProposals != null && appliedProposalCount === flipAfterProposals) {
        pipelineState.state = "failed";
        pipelineState.errorKind = "force_stopped";
      }
      return { changes: 1, rows: [], single: null };
    }
    if (/UPDATE pipeline_jobs SET import_aborted_at/.test(sql)) {
      abortSummaryCalls.push({ sql, args });
      return { changes: 1, rows: [], single: null };
    }
    if (/UPDATE pipeline_jobs SET import_claimed_at = NULL/.test(sql)) {
      releaseCalls.push({ sql, args });
      return { changes: 1, rows: [], single: null };
    }
    throw new Error(`fakeAbortDb: unhandled SQL: ${sql}`);
  }

  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            calls.push({ sql, args });
            return {
              sql,
              args,
              async run() {
                const res = dispatch(sql, args);
                return { meta: { changes: res.changes }, results: res.rows };
              },
              async first() {
                return dispatch(sql, args).single;
              },
              async all() {
                return { results: dispatch(sql, args).rows };
              },
            };
          },
        };
      },
      async batch(stmts) {
        const results = [];
        const batchSqls = [];
        for (const s of stmts) {
          const res = dispatch(s.sql, s.args);
          batchSqls.push({ sql: s.sql, args: s.args });
          results.push({ meta: { changes: res.changes }, results: res.rows });
        }
        batches.push(batchSqls);
        return results;
      },
    },
  };

  return {
    env,
    calls,
    batches,
    abortSummaryCalls,
    releaseCalls,
    get tnInsertCount() {
      return tnInsertCount;
    },
    get tnDeleteUpdateCount() {
      return tnDeleteUpdateCount;
    },
  };
}

// --- resumed-pass: tnDeleted===0 must NOT re-enable TN cancellation — a
//     predecessor's tombstoned rows are invisible here. Second code review of
//     PR #404 flagged the original `tnInsertsCancellable = result.tnDeleted
//     === 0` guard: deleteUnkeptTns's SELECT filters `deleted_at IS NULL` and
//     is idempotent, so a RESUMED pass whose predecessor already tombstoned
//     rows and died before writing their replacements also reports
//     tnDeleted === 0 — the deletes are invisible to it, not absent — and
//     would wrongly re-enable cancellation, reopening the exact DAN 11 shape
//     the guard exists to prevent. state flips to failed/force_stopped right
//     after the FIRST proposal's accept commits (mid-loop), with NO seeded
//     TN-delete rows (tnDeleted === 0 — the "resumed pass" shape). The TN
//     insert loop must have NO cancellation checkpoint at all, so ALL 3
//     proposals land regardless. ---
await withMockedClock(async () => {
  const { env, batches, abortSummaryCalls } = buildFakeAbortDb(1);
  const originalConsoleError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await importJobOutput(
      env,
      { jobId: "job-abort", pipelineType: "notes", book: "GEN", startChapter: 1, endChapter: 1 },
      [],
    );
  } finally {
    console.error = originalConsoleError;
  }

  const tnInsertBatches = batches.filter((b) => b.some((s) => /INSERT INTO tn_rows/.test(s.sql)));

  // (1) the TN insert loop is uncancellable: every proposal lands even though
  //     the job went terminal after the first one's accept committed.
  assert(
    tnInsertBatches.length === 3,
    `resumed-pass (tnDeleted===0): every TN proposal lands despite the mid-flight force-stop (got ${tnInsertBatches.length} of 3)`,
  );

  // (2) this pass never detected the abort — the pre-delete checkpoint (the
  //     ONLY checkpoint a notes run gets) ran before the state flip, and the
  //     TN insert loop has no checkpoint of its own to catch it afterward.
  assert(
    !result.aborted,
    "resumed-pass (tnDeleted===0): result.aborted is falsy — the TN insert loop has no checkpoint to detect the later flip",
  );
  assert(
    abortSummaryCalls.length === 0,
    "resumed-pass (tnDeleted===0): no import_aborted_at UPDATE issued — this pass never stopped",
  );

  // (3) no half-written proposal: every tn_rows write is paired with its
  //     pending_imports accept in the same batch, and the counts match.
  const isAccept = (s) =>
    /SET accepted_at = unixepoch\(\), accepted_by = \?2/.test(s.sql) && !s.sql.includes("EXISTS");
  const totalWrites = batches.filter((b) => b.some((s) => /INSERT INTO tn_rows/.test(s.sql))).length;
  const totalAccepts = batches.filter((b) => b.some(isAccept)).length;
  assert(
    totalWrites === totalAccepts && totalWrites === 3,
    `resumed-pass (tnDeleted===0): all 3 tn_rows writes paired 1:1 with pending_imports accepts (got ${totalWrites} writes, ${totalAccepts} accepts)`,
  );
  for (const b of batches) {
    const hasWrite = b.some((s) => /INSERT INTO tn_rows/.test(s.sql));
    const hasAccept = b.some(isAccept);
    assert(
      hasWrite === hasAccept,
      "resumed-pass (tnDeleted===0): every batch either carries BOTH a tn_rows write and its accept, or NEITHER — no orphans",
    );
  }
});

// --- delete-then-abort (has deletes): the TN insert loop is UNCANCELLABLE
//     unconditionally now, but this is the shape that originally motivated
//     it — the delete phase destroyed rows, so a force-stop landing mid-loop
//     must not strand deleted notes with their replacements unwritten (the
//     DAN 11 shape, permanent once the job goes terminal). Paired with the
//     resumed-pass (tnDeleted===0) variant above, which proves the SAME
//     guarantee holds even when the delete phase's own effect is invisible
//     to this pass. ---
await withMockedClock(async () => {
  // NOTE: tnDeleteUpdateCount is a getter — read it via the returned object
  // AFTER importJobOutput runs, not by destructuring it up front (destructuring
  // a getter snapshots its value at that instant, which would always read 0).
  const fake = buildFakeAbortDb(1, {
    seedTnDeleteRows: [
      { id: "aaaa", version: 1 },
      { id: "bbbb", version: 1 },
    ],
  });
  const { env, batches } = fake;
  const originalConsoleError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await importJobOutput(
      env,
      { jobId: "job-delete-then-abort", pipelineType: "notes", book: "GEN", startChapter: 1, endChapter: 1 },
      [],
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert(
    fake.tnDeleteUpdateCount === 2,
    `delete-then-abort: the delete phase actually deleted rows (got ${fake.tnDeleteUpdateCount})`,
  );

  const tnInsertBatches = batches.filter((b) => b.some((s) => /INSERT INTO tn_rows/.test(s.sql)));
  assert(
    !result.aborted,
    "delete-then-abort: a force-stop after the TN delete phase must NOT strand deleted notes — result.aborted is falsy",
  );
  assert(
    tnInsertBatches.length === 3,
    `delete-then-abort: every insert still lands — all 3 proposals applied despite the mid-flight force-stop (got ${tnInsertBatches.length})`,
  );
  const abortUpdateIssued = batches.some((b) =>
    b.some((s) => /UPDATE pipeline_jobs SET import_aborted_at/.test(s.sql)),
  );
  assert(!abortUpdateIssued, "delete-then-abort: no import_aborted_at UPDATE issued — this pass never stopped");
});

// --- The not-over-eager test: the job stays 'running' throughout — the
//     apply must NOT abort and must apply every proposal. ---
await withMockedClock(async () => {
  const { env, batches } = buildFakeAbortDb(null); // never flips
  const result = await importJobOutput(
    env,
    { jobId: "job-not-aborted", pipelineType: "notes", book: "GEN", startChapter: 1, endChapter: 1 },
    [],
  );

  const tnInsertBatches = batches.filter((b) => b.some((s) => /INSERT INTO tn_rows/.test(s.sql)));
  assert(!result.aborted, "not-over-eager: result.aborted is falsy when the job stays running throughout");
  assert(
    tnInsertBatches.length === 3,
    `not-over-eager: all 3 proposals applied when the job never goes terminal (got ${tnInsertBatches.length})`,
  );
  const abortUpdateIssued = batches.some((b) =>
    b.some((s) => /UPDATE pipeline_jobs SET import_aborted_at/.test(s.sql)),
  );
  assert(!abortUpdateIssued, "not-over-eager: no import_aborted_at UPDATE issued");
});

// --- FIX C, end-to-end: a throwing cancellation SELECT must not fail the
//     apply. The pre-delete checkpoint's forced read (FIX B) throws every
//     time it's asked; importJobOutput must still complete normally with
//     every proposal applied — a cancellation check exists only to stop an
//     apply early and must never be able to fail one instead. ---
await withMockedClock(async () => {
  const { env, batches } = buildFakeAbortDb(null, { throwOnStateRead: true });
  const originalConsoleError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await importJobOutput(
      env,
      { jobId: "job-cancel-throw-e2e", pipelineType: "notes", book: "GEN", startChapter: 1, endChapter: 1 },
      [],
    );
  } finally {
    console.error = originalConsoleError;
  }

  const tnInsertBatches = batches.filter((b) => b.some((s) => /INSERT INTO tn_rows/.test(s.sql)));
  assert(!result.aborted, "FIX C e2e: result.aborted is falsy — a throwing cancellation read is not treated as an abort");
  assert(
    tnInsertBatches.length === 3,
    `FIX C e2e: importJobOutput completes normally and every proposal is applied despite every cancellation read throwing (got ${tnInsertBatches.length} of 3)`,
  );
});

// --- FIX B: the pre-delete checkpoint must FORCE a read even when staging
//     just consumed the rate-limit window. CancelWatch.lastCheckedAt is
//     seeded one interval in the past so the FIRST checkpoint of a pass
//     reads — but that seed is spent by stageJobOutput's own chunk-loop
//     checkpoint. If staging then finishes within one interval (the common
//     single-chapter case), the pre-delete checkpoint would be rate-limited
//     away and never read at all — the exact bug this fix closes.
//
// Drives a FRESH stage (staged_at: null) that fits in one chunk, with the job
// reporting 'running' during staging (so staging's own checkpoint does NOT
// abort) and 'failed'/'force_stopped' on every SELECT after that (simulating
// a force-stop landing in the gap between staging finishing and the apply's
// pre-delete checkpoint). Date.now() is held CONSTANT (no clock advance), so
// shouldCheckCancel's rate limit would refuse a second read within the same
// tick — proving that only `force: true` makes the pre-delete checkpoint
// read anyway. Assert the apply stopped BEFORE the delete phase: no tn_rows
// delete UPDATE and no tn_rows insert were issued at all.
await (async () => {
  const originalFetch = global.fetch;
  const originalNow = Date.now;
  const originalConsoleError = console.error;
  const FIXED_NOW = 1_700_000_000_000;
  Date.now = () => FIXED_NOW; // constant — never satisfies the rate limit on its own
  console.error = () => {};

  const tsvText =
    "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote\n" +
    "1:1\taaaa\t\t\t\t\tnote one\n" +
    "1:2\tbbbb\t\t\t\t\tnote two\n";
  global.fetch = async (_url) => ({ ok: true, text: async () => tsvText });

  const batches = [];
  const dbState = { claimedAt: 1000 };
  let stateReadCount = 0;
  let tnDeleteUpdateCount = 0;
  let tnInsertCount = 0;

  function dispatch(sql, args) {
    if (/UPDATE pipeline_jobs SET import_claimed_at = unixepoch\(\)/.test(sql) && /IS NULL OR/.test(sql)) {
      return { changes: 1, rows: [{ import_claimed_at: dbState.claimedAt }], single: { import_claimed_at: dbState.claimedAt } };
    }
    if (/UPDATE pipeline_jobs SET import_claimed_at = unixepoch\(\)/.test(sql) && /import_claimed_at\s*=\s*\?2/.test(sql)) {
      const expected = args[1];
      if (dbState.claimedAt !== expected) return { changes: 0, rows: [], single: null };
      dbState.claimedAt += 1;
      return { changes: 1, rows: [{ import_claimed_at: dbState.claimedAt }], single: { import_claimed_at: dbState.claimedAt } };
    }
    if (/SELECT staged_at FROM pipeline_jobs/.test(sql)) {
      return { changes: 0, rows: [], single: { staged_at: null } }; // fresh stage — no marker yet
    }
    if (/SELECT state, error_kind FROM pipeline_jobs/.test(sql)) {
      stateReadCount += 1;
      // FIRST read is staging's own checkpoint — job still healthy.
      // Every read after that (the apply's pre-delete checkpoint) sees the
      // force-stop that landed in the gap.
      return stateReadCount === 1
        ? { changes: 0, rows: [], single: { state: "running", error_kind: null } }
        : { changes: 0, rows: [], single: { state: "failed", error_kind: "force_stopped" } };
    }
    if (/DELETE FROM pending_imports/.test(sql)) {
      return { changes: 0, rows: [], single: null };
    }
    if (/INSERT INTO pending_imports/.test(sql)) {
      return { changes: 1, rows: [], single: null };
    }
    if (/UPDATE pipeline_jobs SET staged_at = unixepoch\(\)/.test(sql)) {
      return { changes: 1, rows: [], single: null };
    }
    if (/SELECT user_id FROM pipeline_jobs/.test(sql)) {
      return { changes: 0, rows: [], single: { user_id: 1 } };
    }
    if (/ORDER BY kind, chapter, verse, id/.test(sql)) {
      return {
        changes: 0,
        rows: [
          { id: 1, kind: "tn", book: "GEN", chapter: 1, verse: 1, bible_version: null, payload_json: "{}" },
          { id: 2, kind: "tn", book: "GEN", chapter: 1, verse: 2, bible_version: null, payload_json: "{}" },
        ],
        single: null,
      };
    }
    if (/SELECT id, version FROM tn_rows t/.test(sql)) {
      return { changes: 0, rows: [], single: null }; // no unkept TNs in scope
    }
    if (/SELECT DISTINCT chapter, verse FROM pending_imports/.test(sql)) {
      return { changes: 0, rows: [], single: null }; // no accepted TN proposals yet
    }
    if (/UPDATE tn_rows\s+SET deleted_at/.test(sql)) {
      tnDeleteUpdateCount += 1;
      return { changes: 1, rows: [], single: null };
    }
    if (/MAX\(sort_order\)/.test(sql)) {
      return { changes: 0, rows: [], single: null };
    }
    if (/occurrence, support_reference, quote, note/.test(sql)) {
      return { changes: 0, rows: [], single: null }; // content-dedup claim set: empty
    }
    if (/INSERT INTO tn_rows/.test(sql)) {
      tnInsertCount += 1;
      return { changes: 1, rows: [], single: null };
    }
    if (/INSERT INTO edit_log/.test(sql)) {
      return { changes: 1, rows: [], single: null };
    }
    if (/SET accepted_at = unixepoch\(\), accepted_by = \?2/.test(sql)) {
      return { changes: 1, rows: [], single: null };
    }
    if (/UPDATE pipeline_jobs SET import_aborted_at/.test(sql)) {
      return { changes: 1, rows: [], single: null };
    }
    if (/UPDATE pipeline_jobs SET import_claimed_at = NULL/.test(sql)) {
      return { changes: 1, rows: [], single: null };
    }
    throw new Error(`fakePreDeleteCheckpointDb: unhandled SQL: ${sql}`);
  }

  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              sql,
              args,
              async run() {
                const res = dispatch(sql, args);
                return { meta: { changes: res.changes }, results: res.rows };
              },
              async first() {
                return dispatch(sql, args).single;
              },
              async all() {
                return { results: dispatch(sql, args).rows };
              },
            };
          },
        };
      },
      async batch(stmts) {
        const results = [];
        const batchSqls = [];
        for (const s of stmts) {
          const res = dispatch(s.sql, s.args);
          batchSqls.push({ sql: s.sql, args: s.args });
          results.push({ meta: { changes: res.changes }, results: res.rows });
        }
        batches.push(batchSqls);
        return results;
      },
    },
  };

  let result;
  try {
    result = await importJobOutput(
      env,
      { jobId: "job-forced-predelete", pipelineType: "notes", book: "GEN", startChapter: 1, endChapter: 1 },
      [{ repo: "unfoldingWord/en_tn", rawUrl: "https://example.test/en_tn.tsv" }],
    );
  } finally {
    global.fetch = originalFetch;
    Date.now = originalNow;
    console.error = originalConsoleError;
  }

  assert(stateReadCount >= 2, `forced pre-delete checkpoint: staging AND apply both issued a state read (got ${stateReadCount})`);
  assert(result.aborted === true, "forced pre-delete checkpoint: result.aborted is true — the apply stopped before the delete phase");
  assert(result.abortErrorKind === "force_stopped", "forced pre-delete checkpoint: abortErrorKind captured");
  assert(
    tnDeleteUpdateCount === 0,
    `forced pre-delete checkpoint: NO tn_rows delete UPDATE was issued (got ${tnDeleteUpdateCount})`,
  );
  assert(
    tnInsertCount === 0,
    `forced pre-delete checkpoint: NO tn_rows insert was issued — apply stopped before the delete phase even started (got ${tnInsertCount})`,
  );
  assert(
    batches.every((b) => !b.some((s) => /INSERT INTO tn_rows/.test(s.sql))),
    "forced pre-delete checkpoint: no batch contains a tn_rows insert",
  );
})();

// --- FIX 4(c): the staged_at-skip path was untested — every test above sets
//     staged_at non-null so stageJobOutput's marker check short-circuits
//     before ever reaching the CHUNK loop. Drive a FIRST staging pass (no
//     marker yet) with enough parsed TN rows to span more than one CHUNK of
//     100, and flip the job terminal from the very start so the checkpoint
//     after the FIRST chunk detects it. Assert the chunk loop broke early
//     (fewer rows staged than were parsed) AND that the staged_at UPDATE —
//     which would wrongly mark an INCOMPLETE stage as the complete proposal
//     set — was never issued. ---
await withMockedClock(async () => {
  const ROW_COUNT = 150; // forces 2 chunks at CHUNK=100 (100 + 50)
  const header = "Reference\tID\tTags\tSupportReference\tQuote\tOccurrence\tNote";
  const lines = [header];
  for (let i = 0; i < ROW_COUNT; i++) {
    const id = `id${String(i).padStart(4, "0")}`;
    lines.push(`1:1\t${id}\t\t\t\t\tsome note ${i}`);
  }
  const tsvText = lines.join("\n") + "\n";

  const originalFetch = global.fetch;
  global.fetch = async (_url) => ({ ok: true, text: async () => tsvText });

  const calls = [];
  const batches = [];
  const dbState = { claimedAt: 1000 };
  let insertedRowCount = 0;
  let stagedAtUpdateIssued = false;
  let unresolvedDeleteCount = 0;
  let unresolvedDeleteAfterAbortDetected = false;

  function dispatch(sql, args) {
    if (/UPDATE pipeline_jobs SET import_claimed_at = unixepoch\(\)/.test(sql) && /IS NULL OR/.test(sql)) {
      return { changes: 1, rows: [{ import_claimed_at: dbState.claimedAt }], single: { import_claimed_at: dbState.claimedAt } };
    }
    if (/UPDATE pipeline_jobs SET import_claimed_at = unixepoch\(\)/.test(sql) && /import_claimed_at\s*=\s*\?2/.test(sql)) {
      const expected = args[1];
      if (dbState.claimedAt !== expected) return { changes: 0, rows: [], single: null };
      dbState.claimedAt += 1;
      return { changes: 1, rows: [{ import_claimed_at: dbState.claimedAt }], single: { import_claimed_at: dbState.claimedAt } };
    }
    if (/SELECT staged_at FROM pipeline_jobs/.test(sql)) {
      return { changes: 0, rows: [], single: { staged_at: null } }; // no marker — first stage attempt
    }
    if (/SELECT state, error_kind FROM pipeline_jobs/.test(sql)) {
      // Terminal from the very start: the job was force-stopped before this
      // pass's staging even began, so the very first checkpoint (after the
      // first chunk commits) must catch it.
      return { changes: 0, rows: [], single: { state: "failed", error_kind: "force_stopped" } };
    }
    if (/DELETE FROM pending_imports\s+WHERE job_id = \?1 AND accepted_at IS NULL AND rejected_at IS NULL/.test(sql)) {
      // FIX G: this exact statement fires TWICE in an aborted-stage run — once
      // at the top of stageJobOutput (clearing a prior dead attempt before
      // restaging) and once more after the chunk loop breaks (deleting THIS
      // pass's own now-truncated, never-to-be-resumed proposals so the review
      // UI doesn't show a partial set as complete). Track whether staging
      // already detected the abort (insertedRowCount === 100, the first
      // chunk) by the time a delete fires, to distinguish the SECOND call
      // from the first.
      unresolvedDeleteCount += 1;
      if (insertedRowCount === 100) unresolvedDeleteAfterAbortDetected = true;
      return { changes: 0, rows: [], single: null };
    }
    if (/INSERT INTO pending_imports/.test(sql)) {
      insertedRowCount += 1;
      return { changes: 1, rows: [], single: null };
    }
    if (/UPDATE pipeline_jobs SET staged_at = unixepoch\(\)/.test(sql)) {
      stagedAtUpdateIssued = true;
      return { changes: 1, rows: [], single: null };
    }
    if (/UPDATE pipeline_jobs SET import_aborted_at/.test(sql)) {
      return { changes: 1, rows: [], single: null };
    }
    if (/UPDATE pipeline_jobs SET import_claimed_at = NULL/.test(sql)) {
      return { changes: 1, rows: [], single: null };
    }
    throw new Error(`fakeStagingDb: unhandled SQL: ${sql}`);
  }

  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            calls.push({ sql, args });
            return {
              sql,
              args,
              async run() {
                const res = dispatch(sql, args);
                return { meta: { changes: res.changes }, results: res.rows };
              },
              async first() {
                return dispatch(sql, args).single;
              },
              async all() {
                return { results: dispatch(sql, args).rows };
              },
            };
          },
        };
      },
      async batch(stmts) {
        const results = [];
        const batchSqls = [];
        for (const s of stmts) {
          const res = dispatch(s.sql, s.args);
          batchSqls.push({ sql: s.sql, args: s.args });
          results.push({ meta: { changes: res.changes }, results: res.rows });
        }
        batches.push(batchSqls);
        return results;
      },
    },
  };

  const originalConsoleError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await importJobOutput(
      env,
      { jobId: "job-stage-abort", pipelineType: "notes", book: "GEN", startChapter: 1, endChapter: 1 },
      [{ type: "output", repo: "unfoldingWord/en_tn", rawUrl: "https://example.test/tn.tsv" }],
    );
  } finally {
    console.error = originalConsoleError;
    global.fetch = originalFetch;
  }

  assert(
    insertedRowCount > 0 && insertedRowCount < ROW_COUNT,
    `staged_at-skip: the chunk loop broke early — fewer rows staged than parsed (staged ${insertedRowCount} of ${ROW_COUNT})`,
  );
  assert(
    insertedRowCount === 100,
    `staged_at-skip: exactly the first CHUNK (100) staged before the abort was detected (got ${insertedRowCount})`,
  );
  assert(
    !stagedAtUpdateIssued,
    "staged_at-skip: the staged_at UPDATE was never issued — an incomplete stage must not be marked complete",
  );
  assert(result.aborted === true, "staged_at-skip: result.aborted is true");

  // FIX G: an aborted stage must delete its own unresolved (truncated)
  // pending_imports rows, not just the pre-restage cleanup at the top.
  assert(
    unresolvedDeleteCount === 2,
    `FIX G: the unresolved-proposals DELETE fires twice — once before restaging, once after the abort is detected (got ${unresolvedDeleteCount})`,
  );
  assert(
    unresolvedDeleteAfterAbortDetected,
    "FIX G: the unresolved-proposals DELETE fires AGAIN after the chunk loop breaks, clearing this pass's own truncated set",
  );
});

// --- FIX 4(d): heartbeat.lost + abort. When the lease was already lost (a
//     legitimate new owner re-claimed) AND the job was force-stopped, the
//     abort record's CAS matches zero rows — importJobOutput must still
//     return aborted: true, having ISSUED the abort-record UPDATE (even
//     though it matched nothing), and must log the "not written" diagnostic
//     rather than throwing or silently swallowing it (FIX 3). ---
await withMockedClock(async () => {
  const calls = [];
  const abortUpdateCalls = [];
  const dbState = { claimedAt: 1000 };

  function dispatch(sql, args) {
    if (/UPDATE pipeline_jobs SET import_claimed_at = unixepoch\(\)/.test(sql) && /IS NULL OR/.test(sql)) {
      return { changes: 1, rows: [{ import_claimed_at: dbState.claimedAt }], single: { import_claimed_at: dbState.claimedAt } };
    }
    if (/UPDATE pipeline_jobs SET import_claimed_at = unixepoch\(\)/.test(sql) && /import_claimed_at\s*=\s*\?2/.test(sql)) {
      // Lease already lost: simulate a legitimate new owner holding a
      // different claimedAt value, so every CAS in this pass fails.
      return { changes: 0, rows: [], single: null };
    }
    if (/SELECT staged_at FROM pipeline_jobs/.test(sql)) {
      return { changes: 0, rows: [], single: { staged_at: 999999 } }; // already staged
    }
    if (/SELECT state, error_kind FROM pipeline_jobs/.test(sql)) {
      return { changes: 0, rows: [], single: { state: "failed", error_kind: "force_stopped" } };
    }
    if (/SELECT user_id FROM pipeline_jobs/.test(sql)) {
      return { changes: 0, rows: [], single: { user_id: 1 } };
    }
    if (/ORDER BY kind, chapter, verse, id/.test(sql)) {
      return { changes: 0, rows: [], single: null }; // no proposals; cancel fires before any loop body
    }
    if (/UPDATE pipeline_jobs SET import_aborted_at/.test(sql)) {
      // The CAS's bound claimed value no longer matches the row (lease lost)
      // — matches ZERO rows, exactly the case FIX 3 must not fail silently on.
      abortUpdateCalls.push({ sql, args });
      return { changes: 0, rows: [], single: null };
    }
    if (/UPDATE pipeline_jobs SET import_claimed_at = NULL/.test(sql)) {
      return { changes: 0, rows: [], single: null };
    }
    throw new Error(`fakeHeartbeatLostDb: unhandled SQL: ${sql}`);
  }

  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            calls.push({ sql, args });
            return {
              sql,
              args,
              async run() {
                const res = dispatch(sql, args);
                return { meta: { changes: res.changes }, results: res.rows };
              },
              async first() {
                return dispatch(sql, args).single;
              },
              async all() {
                return { results: dispatch(sql, args).rows };
              },
            };
          },
        };
      },
      async batch(stmts) {
        const results = [];
        for (const s of stmts) {
          const res = dispatch(s.sql, s.args);
          results.push({ meta: { changes: res.changes }, results: res.rows });
        }
        return results;
      },
    },
  };

  let loggedAbortNotWritten = false;
  const originalConsoleError = console.error;
  console.error = (...args) => {
    if (/abort record not written/i.test(String(args[0]))) loggedAbortNotWritten = true;
  };
  let result;
  try {
    result = await importJobOutput(
      env,
      { jobId: "job-heartbeat-lost-abort", pipelineType: "notes", book: "GEN", startChapter: 1, endChapter: 1 },
      [],
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert(result.aborted === true, "heartbeat-lost + abort: result.aborted is still true");
  assert(abortUpdateCalls.length === 1, "heartbeat-lost + abort: the abort-record UPDATE was issued");
  assert(
    (abortUpdateCalls[0]?.args?.length ?? 0) >= 3,
    "heartbeat-lost + abort: the abort-record UPDATE was CAS'd (bound the owned claim value)",
  );
  assert(
    loggedAbortNotWritten,
    "heartbeat-lost + abort: logs that the abort record was not written because the lease was no longer owned",
  );
});

// ── FIX D: the TQ loop may only stop on a verse boundary ────────────────────
// TQ has no delete/preserve concept — every run fully REORDERS the verse to
// match the incoming file, seeding sort_order counters at 0 per verse.
// Breaking mid-verse would leave the first N rows of that verse renumbered
// 100, 200… while the untouched rows keep OLD sort_order values from the
// PREVIOUS run — also 100, 200… — producing duplicate sort_order within one
// verse. Drives 5 TQ proposals across 2 verses (3 in v1, 2 in v2), force-stops
// after the FIRST proposal's accept commits (mid v1), and asserts v1 (which
// received a write) got ALL 3 of its writes, and v2 (untouched) got NONE.
function buildFakeTqBoundaryDb(flipAfterProposals) {
  const batches = [];
  const pipelineState = { state: "running", errorKind: null };
  const dbState = { claimedAt: 2000 };
  let tqInsertCount = 0;
  let acceptedCount = 0;

  const tqProposals = [
    { id: 1, kind: "tq", book: "GEN", chapter: 1, verse: 1, bible_version: null, payload_json: "{}" },
    { id: 2, kind: "tq", book: "GEN", chapter: 1, verse: 1, bible_version: null, payload_json: "{}" },
    { id: 3, kind: "tq", book: "GEN", chapter: 1, verse: 1, bible_version: null, payload_json: "{}" },
    { id: 4, kind: "tq", book: "GEN", chapter: 1, verse: 2, bible_version: null, payload_json: "{}" },
    { id: 5, kind: "tq", book: "GEN", chapter: 1, verse: 2, bible_version: null, payload_json: "{}" },
  ];

  function dispatch(sql, args) {
    if (/UPDATE pipeline_jobs SET import_claimed_at = unixepoch\(\)/.test(sql) && /IS NULL OR/.test(sql)) {
      return { changes: 1, rows: [{ import_claimed_at: dbState.claimedAt }], single: { import_claimed_at: dbState.claimedAt } };
    }
    if (/UPDATE pipeline_jobs SET import_claimed_at = unixepoch\(\)/.test(sql) && /import_claimed_at\s*=\s*\?2/.test(sql)) {
      const expected = args[1];
      if (dbState.claimedAt !== expected) return { changes: 0, rows: [], single: null };
      dbState.claimedAt += 1;
      return { changes: 1, rows: [{ import_claimed_at: dbState.claimedAt }], single: { import_claimed_at: dbState.claimedAt } };
    }
    if (/SELECT staged_at FROM pipeline_jobs/.test(sql)) {
      return { changes: 0, rows: [], single: { staged_at: 999999 } }; // already staged
    }
    if (/SELECT state, error_kind FROM pipeline_jobs/.test(sql)) {
      return { changes: 0, rows: [], single: { state: pipelineState.state, error_kind: pipelineState.errorKind } };
    }
    if (/SELECT user_id FROM pipeline_jobs/.test(sql)) {
      return { changes: 0, rows: [], single: { user_id: 1 } };
    }
    if (/ORDER BY kind, chapter, verse, id/.test(sql)) {
      return { changes: 0, rows: tqProposals, single: null };
    }
    if (/MAX\(sort_order\)/.test(sql)) {
      return { changes: 0, rows: [], single: null };
    }
    if (/SELECT version, chapter, verse FROM tq_rows/.test(sql)) {
      // These proposals carry no proposed id (payload_json: "{}"), so every
      // candidate is a freshly minted random id — never a live row.
      return { changes: 0, rows: [], single: null };
    }
    if (/INSERT INTO tq_rows/.test(sql)) {
      tqInsertCount += 1;
      return { changes: 1, rows: [], single: null };
    }
    if (/INSERT INTO edit_log/.test(sql)) {
      return { changes: 1, rows: [], single: null };
    }
    if (/SET accepted_at = unixepoch\(\), accepted_by = \?2/.test(sql)) {
      acceptedCount += 1;
      if (flipAfterProposals != null && acceptedCount === flipAfterProposals) {
        pipelineState.state = "failed";
        pipelineState.errorKind = "force_stopped";
      }
      return { changes: 1, rows: [], single: null };
    }
    if (/UPDATE pipeline_jobs SET import_aborted_at/.test(sql)) {
      return { changes: 1, rows: [], single: null };
    }
    if (/UPDATE pipeline_jobs SET import_claimed_at = NULL/.test(sql)) {
      return { changes: 1, rows: [], single: null };
    }
    throw new Error(`fakeTqBoundaryDb: unhandled SQL: ${sql}`);
  }

  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              sql,
              args,
              async run() {
                const res = dispatch(sql, args);
                return { meta: { changes: res.changes }, results: res.rows };
              },
              async first() {
                return dispatch(sql, args).single;
              },
              async all() {
                return { results: dispatch(sql, args).rows };
              },
            };
          },
        };
      },
      async batch(stmts) {
        const results = [];
        const batchSqls = [];
        for (const s of stmts) {
          const res = dispatch(s.sql, s.args);
          batchSqls.push({ sql: s.sql, args: s.args });
          results.push({ meta: { changes: res.changes }, results: res.rows });
        }
        batches.push(batchSqls);
        return results;
      },
    },
  };

  return { env, batches, get tqInsertCount() { return tqInsertCount; } };
}

await withMockedClock(async () => {
  const { env, batches } = buildFakeTqBoundaryDb(1); // flip right after the 1st TQ proposal's accept
  const originalConsoleError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await importJobOutput(
      env,
      { jobId: "job-tq-boundary", pipelineType: "tqs", book: "GEN", startChapter: 1, endChapter: 1 },
      [],
    );
  } finally {
    console.error = originalConsoleError;
  }

  const tqInsertBatches = batches.filter((b) => b.some((s) => /INSERT INTO tq_rows/.test(s.sql)));
  assert(
    tqInsertBatches.length === 3,
    `TQ verse boundary: verse 1 (which received a write) got ALL 3 of its writes despite the mid-verse force-stop (got ${tqInsertBatches.length})`,
  );
  assert(result.aborted === true, "TQ verse boundary: result.aborted is true — the boundary check caught the flip before verse 2");
  assert(
    result.applied?.tqCreated === 3,
    `TQ verse boundary: exactly 3 tq rows created, matching verse 1's full proposal set (got ${result.applied?.tqCreated})`,
  );
});

// ── FIX E: the verse loop may only stop on a (chapter, verse) boundary, NOT
//    on bible_version ─────────────────────────────────────────────────────
// A `generate` run stages ULT and UST for the same reference, adjacent but
// separable in proposal order. Aborting between them would leave a verse with
// a fresh AI-aligned ULT but a stale UST (or vice versa). Drives 3 verse
// proposals: (ch1 v1 ULT), (ch1 v1 UST), (ch1 v2 ULT) — force-stops right
// after the FIRST proposal's accept commits (between v1's ULT and UST) — and
// asserts v1's ULT AND UST both land (never split), while v2 is untouched.
function buildFakeVerseBoundaryDb(flipAfterProposals) {
  const batches = [];
  const pipelineState = { state: "running", errorKind: null };
  const dbState = { claimedAt: 3000 };
  let verseInsertCount = 0;
  let acceptedCount = 0;

  const verseProposals = [
    { id: 1, kind: "verse", book: "GEN", chapter: 1, verse: 1, bible_version: "ULT", payload_json: JSON.stringify({ content_json: "" }) },
    { id: 2, kind: "verse", book: "GEN", chapter: 1, verse: 1, bible_version: "UST", payload_json: JSON.stringify({ content_json: "" }) },
    { id: 3, kind: "verse", book: "GEN", chapter: 1, verse: 2, bible_version: "ULT", payload_json: JSON.stringify({ content_json: "" }) },
  ];

  function dispatch(sql, args) {
    if (/UPDATE pipeline_jobs SET import_claimed_at = unixepoch\(\)/.test(sql) && /IS NULL OR/.test(sql)) {
      return { changes: 1, rows: [{ import_claimed_at: dbState.claimedAt }], single: { import_claimed_at: dbState.claimedAt } };
    }
    if (/UPDATE pipeline_jobs SET import_claimed_at = unixepoch\(\)/.test(sql) && /import_claimed_at\s*=\s*\?2/.test(sql)) {
      const expected = args[1];
      if (dbState.claimedAt !== expected) return { changes: 0, rows: [], single: null };
      dbState.claimedAt += 1;
      return { changes: 1, rows: [{ import_claimed_at: dbState.claimedAt }], single: { import_claimed_at: dbState.claimedAt } };
    }
    if (/SELECT staged_at FROM pipeline_jobs/.test(sql)) {
      return { changes: 0, rows: [], single: { staged_at: 999999 } };
    }
    if (/SELECT state, error_kind FROM pipeline_jobs/.test(sql)) {
      return { changes: 0, rows: [], single: { state: pipelineState.state, error_kind: pipelineState.errorKind } };
    }
    if (/SELECT user_id FROM pipeline_jobs/.test(sql)) {
      return { changes: 0, rows: [], single: { user_id: 1 } };
    }
    if (/ORDER BY kind, chapter, verse, id/.test(sql)) {
      return { changes: 0, rows: verseProposals, single: null };
    }
    if (/MAX\(sort_order\)/.test(sql)) {
      return { changes: 0, rows: [], single: null };
    }
    if (/SELECT chapter, verse, content_json FROM verses/.test(sql)) {
      return { changes: 0, rows: [], single: null }; // no UHB/UGNT source rows loaded
    }
    if (/SELECT version, content_json, plain_text, updated_at FROM verses/.test(sql)) {
      return { changes: 0, rows: [], single: null }; // no existing verse row — insert branch
    }
    if (/INSERT INTO verses/.test(sql)) {
      verseInsertCount += 1;
      return { changes: 1, rows: [], single: null };
    }
    if (/INSERT INTO edit_log/.test(sql)) {
      return { changes: 1, rows: [], single: null };
    }
    if (/SET accepted_at = unixepoch\(\), accepted_by = \?2/.test(sql)) {
      acceptedCount += 1;
      if (flipAfterProposals != null && acceptedCount === flipAfterProposals) {
        pipelineState.state = "failed";
        pipelineState.errorKind = "force_stopped";
      }
      return { changes: 1, rows: [], single: null };
    }
    if (/UPDATE pipeline_jobs SET import_aborted_at/.test(sql)) {
      return { changes: 1, rows: [], single: null };
    }
    if (/UPDATE pipeline_jobs SET import_claimed_at = NULL/.test(sql)) {
      return { changes: 1, rows: [], single: null };
    }
    throw new Error(`fakeVerseBoundaryDb: unhandled SQL: ${sql}`);
  }

  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              sql,
              args,
              async run() {
                const res = dispatch(sql, args);
                return { meta: { changes: res.changes }, results: res.rows };
              },
              async first() {
                return dispatch(sql, args).single;
              },
              async all() {
                return { results: dispatch(sql, args).rows };
              },
            };
          },
        };
      },
      async batch(stmts) {
        const results = [];
        const batchSqls = [];
        for (const s of stmts) {
          const res = dispatch(s.sql, s.args);
          batchSqls.push({ sql: s.sql, args: s.args });
          results.push({ meta: { changes: res.changes }, results: res.rows });
        }
        batches.push(batchSqls);
        return results;
      },
    },
  };

  return { env, batches, get verseInsertCount() { return verseInsertCount; } };
}

await withMockedClock(async () => {
  const { env, batches } = buildFakeVerseBoundaryDb(1); // flip right after v1-ULT's accept commits
  const originalConsoleError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await importJobOutput(
      env,
      { jobId: "job-verse-boundary", pipelineType: "generate", book: "GEN", startChapter: 1, endChapter: 1 },
      [],
    );
  } finally {
    console.error = originalConsoleError;
  }

  const verseInsertBatches = batches.filter((b) => b.some((s) => /INSERT INTO verses/.test(s.sql)));
  assert(
    verseInsertBatches.length === 2,
    `verse boundary: v1's ULT AND UST both land (never split) despite the force-stop landing between them (got ${verseInsertBatches.length} of 2)`,
  );
  assert(result.aborted === true, "verse boundary: result.aborted is true — the boundary check caught the flip before v2");
  assert(
    result.applied?.verseUpdated === 2,
    `verse boundary: exactly 2 verse rows updated (v1 ULT + v1 UST), v2 untouched (got ${result.applied?.verseUpdated})`,
  );
});

// ── TQ candidate-id chain: an 8-long DETERMINISTIC chain (seedId, then
//    deriveAltRowId(seedId, 1..7)) walked per proposal. Live-in-same-chapter
//    -> UPDATE; live-in-different-chapter -> step past it; no live row ->
//    INSERT, stepping past a tombstoned PK slot (UNIQUE/PRIMARY KEY) rather
//    than throwing; any other insert error rethrows immediately. The
//    load-bearing property is RE-RUN IDEMPOTENCY: because the chain is
//    deterministic, a second job proposing the same chapter walks the same
//    candidates, finds the row the first run created, and UPDATEs it instead
//    of inserting a duplicate. (1CH 23:7 proposed `hoig`, held by a
//    hand-deleted 1CH 5:4 question — the original incident this guard traces
//    to; the re-run-doubling failure mode is the reason the fix was redesigned
//    away from random re-minting.)

// Configurable fake tq_rows + pipeline_jobs backing store. `liveRows` is a
// mutable Map<id, {version, chapter, verse}> so callers can pre-seed a live row (the
// cross-chapter test) and so the map persists across multiple importJobOutput
// calls against the same env (the re-run-idempotency test). `tombstonedIds`
// simulates a soft-deleted row that still owns its (book, id) PK slot (the
// live-row SELECT filters deleted_at IS NULL, but the INSERT constraint has no
// such filter). `hardErrorIds` simulates a non-UNIQUE insert failure that must
// propagate rather than being retried down the chain.
function buildFakeTqDb({ tombstonedIds = new Set(), hardErrorIds = new Set(), liveRows = new Map() } = {}) {
  const batches = [];
  const insertedIds = [];
  const updatedIds = [];
  const updatedVerses = [];
  const insertAttempts = [];
  const insertArgs = [];
  const pipelineState = { state: "running", errorKind: null };
  const dbState = { claimedAt: 4000 };

  // Each importJobOutput call issues exactly one pending_imports SELECT (in
  // applyJobOutput); proposalsQueue hands out one array per call, in order, so
  // a caller simulating "a new job re-proposes the same content" pushes a
  // fresh array for each run rather than reusing object identity.
  const proposalsQueue = [];
  let proposalsCallIndex = 0;
  function setProposals(rows) {
    proposalsQueue.push(rows);
  }

  function dispatch(sql, args) {
    if (/UPDATE pipeline_jobs SET import_claimed_at = unixepoch\(\)/.test(sql) && /IS NULL OR/.test(sql)) {
      return { changes: 1, rows: [{ import_claimed_at: dbState.claimedAt }], single: { import_claimed_at: dbState.claimedAt } };
    }
    if (/UPDATE pipeline_jobs SET import_claimed_at = unixepoch\(\)/.test(sql) && /import_claimed_at\s*=\s*\?2/.test(sql)) {
      const expected = args[1];
      if (dbState.claimedAt !== expected) return { changes: 0, rows: [], single: null };
      dbState.claimedAt += 1;
      return { changes: 1, rows: [{ import_claimed_at: dbState.claimedAt }], single: { import_claimed_at: dbState.claimedAt } };
    }
    if (/SELECT staged_at FROM pipeline_jobs/.test(sql)) {
      return { changes: 0, rows: [], single: { staged_at: 999999 } }; // already staged
    }
    if (/SELECT state, error_kind FROM pipeline_jobs/.test(sql)) {
      return { changes: 0, rows: [], single: { state: pipelineState.state, error_kind: pipelineState.errorKind } };
    }
    if (/SELECT user_id FROM pipeline_jobs/.test(sql)) {
      return { changes: 0, rows: [], single: { user_id: 1 } };
    }
    if (/ORDER BY kind, chapter, verse, id/.test(sql)) {
      const rows = proposalsQueue[proposalsCallIndex] ?? [];
      proposalsCallIndex += 1;
      return { changes: 0, rows, single: null };
    }
    if (/MAX\(sort_order\)/.test(sql)) {
      return { changes: 0, rows: [], single: null };
    }
    if (/SELECT version, chapter, verse FROM tq_rows/.test(sql)) {
      const id = args[0];
      const row = liveRows.get(id) ?? null;
      return { changes: 0, rows: row ? [row] : [], single: row };
    }
    if (/UPDATE tq_rows\s+SET/.test(sql)) {
      // bind order per applyTqUpsert's UPDATE: ref_raw(0), tags(1), quote(2),
      // occurrence(3), question(4), response(5), sort_order(6), verse(7),
      // updated_at(8), updated_by(9), id(10), book(11).
      const id = args[10];
      updatedIds.push(id);
      updatedVerses.push(args[7]);
      return { changes: 1, rows: [], single: null };
    }
    if (/INSERT INTO tq_rows/.test(sql)) {
      const id = args[0];
      const chapter = args[2];
      const verse = args[3];
      insertAttempts.push(id);
      insertArgs.push(args);
      if (hardErrorIds.has(id)) {
        throw new Error("D1_ERROR: NOT NULL constraint failed: tq_rows.question: SQLITE_CONSTRAINT_NOTNULL");
      }
      if (tombstonedIds.has(id)) {
        throw new Error(
          "D1_ERROR: UNIQUE constraint failed: tq_rows.book, tq_rows.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)",
        );
      }
      insertedIds.push(id);
      liveRows.set(id, { version: 1, chapter, verse });
      return { changes: 1, rows: [], single: null };
    }
    if (/INSERT INTO edit_log/.test(sql)) {
      return { changes: 1, rows: [], single: null };
    }
    if (/SET accepted_at = unixepoch\(\), accepted_by = \?2/.test(sql)) {
      return { changes: 1, rows: [], single: null };
    }
    if (/UPDATE pipeline_jobs SET import_aborted_at/.test(sql)) {
      return { changes: 1, rows: [], single: null };
    }
    if (/UPDATE pipeline_jobs SET import_claimed_at = NULL/.test(sql)) {
      return { changes: 1, rows: [], single: null };
    }
    throw new Error(`fakeTqDb: unhandled SQL: ${sql}`);
  }

  const env = {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              sql,
              args,
              async run() {
                const res = dispatch(sql, args);
                return { meta: { changes: res.changes }, results: res.rows };
              },
              async first() {
                return dispatch(sql, args).single;
              },
              async all() {
                return { results: dispatch(sql, args).rows };
              },
            };
          },
        };
      },
      async batch(stmts) {
        const results = [];
        const batchSqls = [];
        for (const s of stmts) {
          const res = dispatch(s.sql, s.args);
          batchSqls.push({ sql: s.sql, args: s.args });
          results.push({ meta: { changes: res.changes }, results: res.rows });
        }
        batches.push(batchSqls);
        return results;
      },
    },
  };

  return { env, batches, insertedIds, updatedIds, updatedVerses, insertAttempts, insertArgs, liveRows, setProposals };
}

await withMockedClock(async () => {
  const { env, batches, insertedIds, updatedIds, setProposals } = buildFakeTqDb({
    tombstonedIds: new Set(["hoig"]),
  });

  const tqProposals = () => [
    {
      id: 1,
      kind: "tq",
      book: "GEN",
      chapter: 1,
      verse: 1,
      bible_version: null,
      payload_json: JSON.stringify({ id: "hoig", book: "GEN", chapter: 1, verse: 1, question: "q-tombstone" }),
    },
    {
      id: 2,
      kind: "tq",
      book: "GEN",
      chapter: 1,
      verse: 2,
      bible_version: null,
      payload_json: JSON.stringify({ id: "abc1", book: "GEN", chapter: 1, verse: 2, question: "q-clean" }),
    },
    {
      id: 3,
      kind: "tq",
      book: "GEN",
      chapter: 1,
      verse: 3,
      bible_version: null,
      payload_json: JSON.stringify({ id: "9BAD", book: "GEN", chapter: 1, verse: 3, question: "q-malformed" }),
    },
  ];

  const originalConsoleError = console.error;
  console.error = () => {};
  let result;
  try {
    setProposals(tqProposals());
    result = await importJobOutput(
      env,
      { jobId: "job-tq-chain", pipelineType: "tqs", book: "GEN", startChapter: 1, endChapter: 1 },
      [],
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert(
    result.aborted !== true && result.applied?.tqCreated === 3,
    `TQ candidate chain: the job completes with all 3 rows created instead of throwing on the tombstoned PK slot (aborted=${result.aborted}, tqCreated=${result.applied?.tqCreated})`,
  );
  assert(insertedIds.length === 3, `TQ candidate chain: all 3 proposals reached an INSERT (got ${insertedIds.length})`);
  assert(
    insertedIds[0] === deriveAltRowId("hoig", 1),
    `TQ candidate chain: the proposal colliding with tombstoned "hoig" lands on the exact deterministic next candidate deriveAltRowId("hoig", 1) (${deriveAltRowId("hoig", 1)}), not just "some other id" (got "${insertedIds[0]}")`,
  );
  assert(
    insertedIds[1] === "abc1",
    `TQ candidate chain: a clean, free proposed id ("abc1") is preserved verbatim, not over-corrected into always minting (got "${insertedIds[1]}")`,
  );
  assert(
    insertedIds[2] === coerceRowId("9BAD"),
    `TQ candidate chain: a malformed proposed id ("9BAD") is inserted as its coerced form coerceRowId("9BAD") (${coerceRowId("9BAD")}), never as "9BAD" itself (got "${insertedIds[2]}")`,
  );
  assert(insertedIds[2] !== "9BAD", `TQ candidate chain: the malformed id "9BAD" itself is never inserted (got "${insertedIds[2]}")`);

  const tombstoneInsertBatch = batches.find(
    (b) => b.some((s) => /INSERT INTO tq_rows/.test(s.sql) && s.args[0] === insertedIds[0]),
  );
  const tombstoneEditLog = tombstoneInsertBatch?.find((s) => /INSERT INTO edit_log/.test(s.sql));
  assert(
    tombstoneEditLog?.args[0] === insertedIds[0],
    `TQ candidate chain: the edit_log row for the tombstone case carries the id that was ACTUALLY inserted (${insertedIds[0]}), not the proposed "hoig" (got "${tombstoneEditLog?.args[0]}")`,
  );

  // ── RE-RUN IDEMPOTENCY (the key property this redesign exists for) ──
  // A second job re-proposes the exact same three notes for the same chapter,
  // against the SAME env (so the live-rows map created by run 1 persists).
  // Because the candidate chain is deterministic, every proposal must walk the
  // identical chain, land on the row run 1 created, and UPDATE it — never
  // insert a second copy.
  setProposals(tqProposals());
  console.error = () => {};
  let rerunResult;
  try {
    rerunResult = await importJobOutput(
      env,
      { jobId: "job-tq-chain", pipelineType: "tqs", book: "GEN", startChapter: 1, endChapter: 1 },
      [],
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert(
    rerunResult.aborted !== true,
    `TQ re-run idempotency: the second run completes without aborting (aborted=${rerunResult.aborted})`,
  );
  assert(
    insertedIds.length === 3,
    `TQ re-run idempotency: a re-run for the same chapter must UPDATE the rows the first run created, never insert duplicate copies — insertedIds stayed at 3 (got ${insertedIds.length})`,
  );
  assert(
    updatedIds.length === 3 &&
      updatedIds.includes(insertedIds[0]) &&
      updatedIds.includes(insertedIds[1]) &&
      updatedIds.includes(insertedIds[2]),
    `TQ re-run idempotency: all 3 of run 1's inserted ids (${insertedIds.join(",")}) took the UPDATE branch on re-run (got updatedIds=${updatedIds.join(",")})`,
  );
});

// ── Cross-chapter live id is not trampled: a live row at the candidate id in
//    a DIFFERENT chapter must be stepped past, never overwritten ──
await withMockedClock(async () => {
  const { env, insertedIds, updatedIds, setProposals } = buildFakeTqDb({
    liveRows: new Map([["xyz1", { version: 1, chapter: 1 }]]),
  });

  setProposals([
    {
      id: 1,
      kind: "tq",
      book: "GEN",
      chapter: 2,
      verse: 1,
      bible_version: null,
      payload_json: JSON.stringify({ id: "xyz1", book: "GEN", chapter: 2, verse: 1, question: "q-cross-chapter" }),
    },
  ]);

  const originalConsoleError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await importJobOutput(
      env,
      { jobId: "job-tq-cross-chapter", pipelineType: "tqs", book: "GEN", startChapter: 2, endChapter: 2 },
      [],
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert(result.aborted !== true, `TQ cross-chapter guard: the job completes (aborted=${result.aborted})`);
  assert(
    !updatedIds.includes("xyz1"),
    `TQ cross-chapter guard: the chapter-1 live row at "xyz1" is left alone, not trampled by a chapter-2 proposal (updatedIds=${updatedIds.join(",")})`,
  );
  assert(
    insertedIds.includes(deriveAltRowId("xyz1", 1)),
    `TQ cross-chapter guard: the chapter-2 proposal steps to the next deterministic candidate deriveAltRowId("xyz1", 1) (${deriveAltRowId("xyz1", 1)}) instead of overwriting the chapter-1 row (insertedIds=${insertedIds.join(",")})`,
  );
});

// ── Non-UNIQUE insert errors are not retried down the chain — they rethrow
//    immediately, so the caller sees the real failure instead of a job that
//    silently exhausts all 8 candidates and reports a misleading "collision
//    exhausted" error ──
await withMockedClock(async () => {
  const { env, insertAttempts, setProposals } = buildFakeTqDb({
    hardErrorIds: new Set(["errd"]),
  });

  setProposals([
    {
      id: 1,
      kind: "tq",
      book: "GEN",
      chapter: 1,
      verse: 1,
      bible_version: null,
      payload_json: JSON.stringify({ id: "errd", book: "GEN", chapter: 1, verse: 1, question: "q-hard-error" }),
    },
  ]);

  const originalConsoleError = console.error;
  console.error = () => {};
  let threw = null;
  try {
    await importJobOutput(
      env,
      { jobId: "job-tq-hard-error", pipelineType: "tqs", book: "GEN", startChapter: 1, endChapter: 1 },
      [],
    );
  } catch (e) {
    threw = e;
  } finally {
    console.error = originalConsoleError;
  }

  assert(
    threw != null && /NOT NULL/.test(threw.message),
    `TQ non-UNIQUE error: importJobOutput rejects with the underlying NOT NULL failure instead of swallowing it (got ${threw?.message ?? "no throw"})`,
  );
  assert(
    insertAttempts.length === 1,
    `TQ non-UNIQUE error: the chain stops after the first insert attempt instead of retrying all 8 candidates (got ${insertAttempts.length} attempts: ${insertAttempts.join(",")})`,
  );
});

// ── Same-chapter alt-id merge cannot happen silently: two proposals in the
//    SAME chapter whose seed ids are BOTH tombstoned must land on two
//    DIFFERENT alternate ids and both reach INSERT — this is exactly the
//    scenario the deriveAltRowId entropy fix protects (a collapsed output
//    pool could make two colliding proposals derive the same alternate id,
//    at which point the second silently UPDATEs over the first) ──
await withMockedClock(async () => {
  const { env, insertedIds, updatedIds, setProposals } = buildFakeTqDb({
    tombstonedIds: new Set(["hoig", "zorp"]),
  });

  setProposals([
    {
      id: 1,
      kind: "tq",
      book: "GEN",
      chapter: 1,
      verse: 1,
      bible_version: null,
      payload_json: JSON.stringify({ id: "hoig", book: "GEN", chapter: 1, verse: 1, question: "q-tombstone-1" }),
    },
    {
      id: 2,
      kind: "tq",
      book: "GEN",
      chapter: 1,
      verse: 2,
      bible_version: null,
      payload_json: JSON.stringify({ id: "zorp", book: "GEN", chapter: 1, verse: 2, question: "q-tombstone-2" }),
    },
  ]);

  const originalConsoleError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await importJobOutput(
      env,
      { jobId: "job-tq-same-chapter-collision", pipelineType: "tqs", book: "GEN", startChapter: 1, endChapter: 1 },
      [],
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert(result.aborted !== true, `TQ same-chapter alt-id merge guard: the job completes (aborted=${result.aborted})`);
  assert(
    insertedIds.length === 2 && updatedIds.length === 0,
    `TQ same-chapter alt-id merge guard: two proposals with distinct tombstoned seeds in the same chapter both ` +
      `reach INSERT and none silently merge into an UPDATE (insertedIds=${insertedIds.join(",")}, updatedIds=${updatedIds.join(",")})`,
  );
  assert(
    insertedIds[0] !== insertedIds[1],
    `TQ same-chapter alt-id merge guard: the two proposals land on DIFFERENT alternate ids ` +
      `(deriveAltRowId("hoig",1)=${deriveAltRowId("hoig", 1)}, deriveAltRowId("zorp",1)=${deriveAltRowId("zorp", 1)}) ` +
      `— a collapsed id pool would let them collide and the second would silently overwrite the first (got ${insertedIds.join(",")})`,
  );
});

// ── The UPDATE branch writes `verse`: a question moved to another verse of
//    the same chapter must not stay filed under its old verse ──
await withMockedClock(async () => {
  const { env, updatedVerses, setProposals } = buildFakeTqDb({
    liveRows: new Map([["abc1", { version: 1, chapter: 1 }]]),
  });

  setProposals([
    {
      id: 1,
      kind: "tq",
      book: "GEN",
      chapter: 1,
      verse: 5,
      bible_version: null,
      payload_json: JSON.stringify({ id: "abc1", book: "GEN", chapter: 1, verse: 5, question: "q-moved-verse" }),
    },
  ]);

  const originalConsoleError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await importJobOutput(
      env,
      { jobId: "job-tq-verse-move", pipelineType: "tqs", book: "GEN", startChapter: 1, endChapter: 1 },
      [],
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert(result.aborted !== true, `TQ verse-move: the job completes (aborted=${result.aborted})`);
  assert(
    updatedVerses.length === 1 && updatedVerses[0] === 5,
    `TQ verse-move: a live row at verse 1 updated by a proposal for verse 5 must have its UPDATE bind verse=5, ` +
      `not stay filed under its old verse (got updatedVerses=${updatedVerses.join(",")})`,
  );
});

// ── insertTqAtId binds the pending_imports book/chapter/verse, not the
//    payload's — a stray TSV cell in the payload must not divert the row
//    into a different (book, id) space than the one the caller checked ──
await withMockedClock(async () => {
  const { env, insertArgs, setProposals } = buildFakeTqDb();

  setProposals([
    {
      id: 1,
      kind: "tq",
      book: "GEN",
      chapter: 1,
      verse: 1,
      bible_version: null,
      payload_json: JSON.stringify({
        id: "abc1",
        book: "EXO",
        chapter: 9,
        verse: 9,
        question: "q-payload-mismatch",
      }),
    },
  ]);

  const originalConsoleError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await importJobOutput(
      env,
      { jobId: "job-tq-payload-mismatch", pipelineType: "tqs", book: "GEN", startChapter: 1, endChapter: 1 },
      [],
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert(result.aborted !== true, `TQ payload book/chapter/verse guard: the job completes (aborted=${result.aborted})`);
  assert(insertArgs.length === 1, `TQ payload book/chapter/verse guard: exactly one INSERT was attempted (got ${insertArgs.length})`);
  // cols = ["id", "book", "chapter", "verse", ...] so args[1]=book, args[2]=chapter, args[3]=verse.
  const [, insertedBook, insertedChapter, insertedVerse] = insertArgs[0];
  assert(
    insertedBook === "GEN" && insertedChapter === 1 && insertedVerse === 1,
    `TQ payload book/chapter/verse guard: the INSERT binds the pending_imports row's book/chapter/verse ` +
      `(GEN/1/1), not the payload's mismatched EXO/9/9 (got ${insertedBook}/${insertedChapter}/${insertedVerse})`,
  );
});

// ── A randomly minted candidate must never adopt a live row: a tq proposal
//    with NO id at all (payload_json has no "id", so seedId is null and
//    every candidate id is a fresh newRowId()) must never overwrite a live
//    row it happens to land on — a random candidate asserts no identity, so a
//    live row there belongs to some OTHER question, and updating it would
//    silently destroy it while marking this unrelated proposal "accepted".
//    This is a SILENT DATA LOSS scenario. ──
await withMockedClock(async () => {
  // Math.random is stubbed so newRowId()'s first draw is deterministic
  // ("aaaa": newRowId makes 4 calls per id — 1 for ID_LETTERS[floor(r*24)]
  // then 3 for ID_CHARS[floor(r*32)] — all four Math.random()=0 draws map to
  // index 0, i.e. 'a' each time) and its second draw is a different,
  // also-deterministic id ("nsss": four Math.random()=0.5 draws). Verified
  // directly against rowId.ts's newRowId before writing this test.
  const firstDrawnId = "aaaa";
  const secondDrawnId = "nsss";

  const { env, insertedIds, updatedIds, setProposals } = buildFakeTqDb({
    liveRows: new Map([[firstDrawnId, { version: 1, chapter: 1, verse: 9 }]]),
  });

  setProposals([
    {
      id: 1,
      kind: "tq",
      book: "GEN",
      chapter: 1,
      verse: 1,
      bible_version: null,
      // No "id" field at all -> seedId is null -> every candidate is a random newRowId().
      payload_json: JSON.stringify({ book: "GEN", chapter: 1, verse: 1, question: "q-random-mint" }),
    },
  ]);

  let callCount = 0;
  const originalRandom = Math.random;
  Math.random = () => {
    callCount++;
    return callCount <= 4 ? 0 : 0.5;
  };
  const originalConsoleError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await importJobOutput(
      env,
      { jobId: "job-tq-random-mint", pipelineType: "tqs", book: "GEN", startChapter: 1, endChapter: 1 },
      [],
    );
  } finally {
    Math.random = originalRandom;
    console.error = originalConsoleError;
  }

  assert(result.aborted !== true, `TQ random-mint guard: the job completes (aborted=${result.aborted})`);
  assert(
    updatedIds.length === 0,
    `TQ random-mint guard (SILENT DATA LOSS if this fails): a proposal with no seed id must never adopt (UPDATE) ` +
      `a live row it randomly lands on — the live row at "${firstDrawnId}" belongs to some other question, and ` +
      `updating it would silently overwrite that question while marking this unrelated proposal accepted ` +
      `(got updatedIds=${updatedIds.join(",")})`,
  );
  assert(
    insertedIds.length === 1 && insertedIds[0] === secondDrawnId,
    `TQ random-mint guard: the proposal steps past the live "${firstDrawnId}" and INSERTs at the next random draw ` +
      `"${secondDrawnId}" instead (got insertedIds=${insertedIds.join(",")})`,
  );
});

// ── A derived candidate must not adopt a live row at a DIFFERENT verse: two
//    seeds — "aa8a" and "abr4" — were found by brute force (iterating every
//    valid 4-char id and comparing deriveAltRowId(id, 1)) to hash to the SAME
//    alternate id. This is a genuine ~1-in-786k-per-pair coincidence, not a
//    contrived input, but the consequence (one proposal's INSERT silently
//    turning into an UPDATE that overwrites an unrelated live question) is
//    SILENT DATA LOSS, so it is worth hardcoding as a regression test. Both
//    seeds are tombstoned so both proposals step to attempt 1 and land on the
//    shared derived id; the two proposals are filed at DIFFERENT verses (1
//    and 2) of the same chapter, so the second must not treat the first's
//    freshly-inserted row as its own. ──
await withMockedClock(async () => {
  const s1 = "aa8a";
  const s2 = "abr4";
  const sharedAlt = deriveAltRowId(s1, 1);
  assert(
    sharedAlt === deriveAltRowId(s2, 1),
    `TQ derived-candidate verse guard: test setup sanity check — deriveAltRowId("${s1}",1) and ` +
      `deriveAltRowId("${s2}",1) must actually collide (got ${sharedAlt} vs ${deriveAltRowId(s2, 1)})`,
  );

  const { env, insertedIds, updatedIds, setProposals } = buildFakeTqDb({
    tombstonedIds: new Set([s1, s2]),
  });

  setProposals([
    {
      id: 1,
      kind: "tq",
      book: "GEN",
      chapter: 1,
      verse: 1,
      bible_version: null,
      payload_json: JSON.stringify({ id: s1, book: "GEN", chapter: 1, verse: 1, question: "q-derived-1" }),
    },
    {
      id: 2,
      kind: "tq",
      book: "GEN",
      chapter: 1,
      verse: 2,
      bible_version: null,
      payload_json: JSON.stringify({ id: s2, book: "GEN", chapter: 1, verse: 2, question: "q-derived-2" }),
    },
  ]);

  const originalConsoleError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await importJobOutput(
      env,
      { jobId: "job-tq-derived-verse-mismatch", pipelineType: "tqs", book: "GEN", startChapter: 1, endChapter: 1 },
      [],
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert(result.aborted !== true, `TQ derived-candidate verse guard: the job completes (aborted=${result.aborted})`);
  assert(
    !updatedIds.includes(sharedAlt),
    `TQ derived-candidate verse guard (SILENT DATA LOSS if this fails): two seeds hashing to the same alternate ` +
      `id ("${sharedAlt}") at DIFFERENT verses (1 vs 2) must not let the second proposal silently UPDATE over ` +
      `(overwrite) the first proposal's question (got updatedIds=${updatedIds.join(",")})`,
  );
  assert(
    insertedIds.length === 2 && new Set(insertedIds).size === 2,
    `TQ derived-candidate verse guard: both proposals reach INSERT at two DISTINCT ids instead of the second ` +
      `merging into an UPDATE of the first (got insertedIds=${insertedIds.join(",")})`,
  );
});

// ── Companion: the intended-adoption case still works — a derived candidate
//    whose live row is the SAME chapter AND SAME verse IS adopted (UPDATE,
//    not a duplicate insert). This is the re-run idempotency path for a
//    tombstoned seed and must not regress from the two guards above. ──
await withMockedClock(async () => {
  const seed = "hoig"; // tombstoned, so attempt 1 is the first live candidate checked
  const derivedId = deriveAltRowId(seed, 1);

  const { env, insertedIds, updatedIds, setProposals } = buildFakeTqDb({
    tombstonedIds: new Set([seed]),
    liveRows: new Map([[derivedId, { version: 1, chapter: 1, verse: 3 }]]),
  });

  setProposals([
    {
      id: 1,
      kind: "tq",
      book: "GEN",
      chapter: 1,
      verse: 3,
      bible_version: null,
      payload_json: JSON.stringify({ id: seed, book: "GEN", chapter: 1, verse: 3, question: "q-rerun-derived" }),
    },
  ]);

  const originalConsoleError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await importJobOutput(
      env,
      { jobId: "job-tq-derived-samechapter-verse", pipelineType: "tqs", book: "GEN", startChapter: 1, endChapter: 1 },
      [],
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert(result.aborted !== true, `TQ derived-candidate adoption: the job completes (aborted=${result.aborted})`);
  assert(
    updatedIds.length === 1 && updatedIds[0] === derivedId,
    `TQ derived-candidate adoption: a derived candidate whose live row is the SAME chapter AND verse IS adopted ` +
      `(UPDATE), not duplicated as a new insert — this is the re-run idempotency path and must not regress ` +
      `(got updatedIds=${updatedIds.join(",")}, insertedIds=${insertedIds.join(",")})`,
  );
  assert(
    insertedIds.length === 0,
    `TQ derived-candidate adoption: no new INSERT happens when the derived candidate's live row is legitimately ` +
      `ours (got insertedIds=${insertedIds.join(",")})`,
  );
});

// ── SAME-verse twin of the guard above: the chapter+verse check alone cannot
//    separate two proposals that land in the SAME verse — which is normal,
//    since a verse routinely has several questions. Seeds "aa8a" and "abr4"
//    both hash (deriveAltRowId(seed, 1)) to the same alternate id "fdvf"; both
//    are tombstoned so both proposals step to attempt 1 and reach that id.
//    Proposal A inserts at "fdvf" first. Without claimedIds, proposal B would
//    then find "fdvf" live at the SAME chapter AND SAME verse as itself,
//    read that as "my row from a previous run", and UPDATE over it —
//    destroying A's question while marking B accepted. claimedIds (populated
//    on every UPDATE/INSERT success within this pass) is what tells B that
//    "fdvf" was just claimed by A this run, so B steps to attempt 2 instead. ──
await withMockedClock(async () => {
  const s1 = "aa8a";
  const s2 = "abr4";
  const sharedAlt = deriveAltRowId(s1, 1);
  assert(
    sharedAlt === deriveAltRowId(s2, 1),
    `TQ same-verse claim guard: test setup sanity check — deriveAltRowId("${s1}",1) and ` +
      `deriveAltRowId("${s2}",1) must actually collide (got ${sharedAlt} vs ${deriveAltRowId(s2, 1)})`,
  );

  const { env, insertedIds, updatedIds, setProposals } = buildFakeTqDb({
    tombstonedIds: new Set([s1, s2]),
  });

  setProposals([
    {
      id: 1,
      kind: "tq",
      book: "GEN",
      chapter: 1,
      verse: 1,
      bible_version: null,
      payload_json: JSON.stringify({ id: s1, book: "GEN", chapter: 1, verse: 1, question: "q-same-verse-1" }),
    },
    {
      id: 2,
      kind: "tq",
      book: "GEN",
      chapter: 1,
      verse: 1,
      bible_version: null,
      payload_json: JSON.stringify({ id: s2, book: "GEN", chapter: 1, verse: 1, question: "q-same-verse-2" }),
    },
  ]);

  const originalConsoleError = console.error;
  console.error = () => {};
  let result;
  try {
    result = await importJobOutput(
      env,
      { jobId: "job-tq-same-verse-claim", pipelineType: "tqs", book: "GEN", startChapter: 1, endChapter: 1 },
      [],
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert(result.aborted !== true, `TQ same-verse claim guard: the job completes (aborted=${result.aborted})`);
  assert(
    insertedIds.length === 2 && new Set(insertedIds).size === 2,
    `TQ same-verse claim guard (SILENT DATA LOSS if this fails): two questions in the same verse whose ids hash ` +
      `to the same alternate id must not collapse into one row — both proposals must reach INSERT at two ` +
      `DISTINCT ids (got insertedIds=${insertedIds.join(",")})`,
  );
  assert(
    insertedIds[0] === sharedAlt,
    `TQ same-verse claim guard: the first proposal lands on the shared derived id ("${sharedAlt}") ` +
      `(got insertedIds[0]="${insertedIds[0]}")`,
  );
  assert(
    insertedIds[1] !== sharedAlt,
    `TQ same-verse claim guard (SILENT DATA LOSS if this fails): the second proposal must step past the ` +
      `just-claimed id ("${sharedAlt}") to a further candidate instead of colliding with it ` +
      `(got insertedIds=${insertedIds.join(",")})`,
  );
  assert(
    !updatedIds.includes(sharedAlt),
    `TQ same-verse claim guard (SILENT DATA LOSS if this fails): the second proposal must not UPDATE over the ` +
      `first proposal's freshly-inserted row at "${sharedAlt}" (got updatedIds=${updatedIds.join(",")})`,
  );
  assert(
    result.applied?.tqCreated === 2,
    `TQ same-verse claim guard: both questions survive as separate created rows (got tqCreated=${result.applied?.tqCreated})`,
  );
});

// ─── tnPayload / tqPayload quote curling (AI-pipeline note/question/response) ──
// JER 32/33 / NUM 26:53 prod forensics found straight quotes only in VERSE
// content — this covers the sibling fix for note/question/response PROSE,
// reusing tsvFormat.ts's educateQuotes (same rules the TSV export already
// applies) so an AI-drafted note is never inconsistent with a human-typed one.

{
  const built = tnPayload("GEN", "1:1", {
    Reference: "1:1",
    ID: "aaaa",
    Tags: "",
    SupportReference: "",
    Quote: "",
    Occurrence: "",
    Note: 'The word "beginning" means the start.',
  });
  assert(
    built.payload.note === "The word “beginning” means the start.",
    `tnPayload curls straight quotes in Note prose (got ${JSON.stringify(built.payload.note)})`,
  );
}

{
  // Quote field is deliberately left untouched — it must match the exact
  // target-language surface text for occurrence resolution (occurrenceRule.ts),
  // and can carry Hebrew/Greek (origLangOccurrence). Scope is note/question/
  // response prose only.
  const built = tnPayload("GEN", "1:1", {
    Reference: "1:1",
    ID: "aaaa",
    Tags: "",
    SupportReference: "",
    Quote: 'the "beginning"',
    Occurrence: "1",
    Note: "no straight quotes here",
  });
  assert(built.payload.quote === 'the "beginning"', "tnPayload leaves the Quote field untouched");
}

{
  const built = tqPayload("GEN", "1:1", {
    Reference: "1:1",
    ID: "aaaa",
    Tags: "",
    Quote: "",
    Occurrence: "",
    Question: 'What does "beginning" mean?',
    Response: "It's the start of everything.",
  });
  assert(
    built.payload.question === "What does “beginning” mean?",
    `tqPayload curls straight quotes in Question prose (got ${JSON.stringify(built.payload.question)})`,
  );
  assert(
    built.payload.response === "It’s the start of everything.",
    `tqPayload curls a straight apostrophe in Response prose (got ${JSON.stringify(built.payload.response)})`,
  );
}

{
  // No-op on prose that already carries no straight quotes.
  const built = tnPayload("GEN", "1:1", {
    Reference: "1:1",
    ID: "aaaa",
    Tags: "",
    SupportReference: "",
    Quote: "",
    Occurrence: "",
    Note: "already curly — “beginning” means the start.",
  });
  assert(
    built.payload.note === "already curly — “beginning” means the start.",
    "tnPayload: already-curly Note is a no-op",
  );
}

console.log("pipelineImport (claim guard): all assertions passed");
