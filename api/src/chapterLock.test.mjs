// Regression test for the resource-scoped chapter lock. The bug (issue #352):
// a running "tqs" job locked the WHOLE chapter, so a translator who asked for
// AI questions could no longer edit word links, notes or scripture. A run may
// only lock what it will overwrite when it lands — including the steps still
// pending on a chained "generate everything" run.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/chapterLock.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors sortOrder.test.mjs.

import {
  activePipelineForChapter,
  chainRootJobId,
  lockedResourceFor,
  lockedResourcesForChapter,
  resourcesLockedByJob,
  resourcesWrittenBy,
} from "./chapterLock.ts";
import { readFileSync as readSourceSync } from "node:fs";
import { join as joinPath, dirname as dirName } from "node:path";
import { fileURLToPath as toPath } from "node:url";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// Minimal D1 stand-in. The query is now static (book / chapter / state only —
// the resource match happens in JS), so the stub applies exactly those three
// predicates against an in-memory job list. It asserts the SQL shape it relies
// on, so a query change can't silently leave this test answering a question the
// code no longer asks.
function fakeEnv(jobs) {
  return {
    DB: {
      prepare(sql) {
        // Two shapes now. The state-filtered one is the original question ("what
        // is running here"); the unfiltered one is #828's chain-sibling lookup,
        // which must see finished links too and therefore must NOT carry a state
        // predicate. Anything else is a query the tests do not model.
        const stateFiltered = /state IN \(\?3, \?4, \?5, \?6\)/.test(sql);
        if (!stateFiltered && !/SELECT job_id, pipeline_type\s+FROM pipeline_jobs/.test(sql)) {
          throw new Error(`unexpected state predicate in SQL:\n${sql}`);
        }
        if (/pipeline_type\s+IN/.test(sql)) {
          throw new Error("SQL must not filter pipeline_type — chain steps are matched in JS");
        }
        return {
          bind(book, chapter, ...states) {
            const allowed = stateFiltered ? new Set(states) : null;
            return {
              async all() {
                return {
                  results: jobs
                    .filter(
                      (j) =>
                        j.book === book &&
                        j.start_chapter <= chapter &&
                        j.end_chapter >= chapter &&
                        (allowed === null || allowed.has(j.state)),
                    )
                    .sort((a, b) => a.created_at - b.created_at),
                };
              },
            };
          },
        };
      },
    },
  };
}

const job = (pipeline_type, state = "running", follow_up_chain = null) => ({
  job_id: `job-${pipeline_type}`,
  pipeline_type,
  user_id: 1,
  created_at: 1000,
  book: "ZEC",
  start_chapter: 1,
  end_chapter: 3,
  state,
  follow_up_chain,
});

// ─── A questions run locks questions only (the reported bug) ──────────────
{
  console.log("\n[tqs running]");
  const env = fakeEnv([job("tqs")]);
  const at = (r) => activePipelineForChapter(env, "ZEC", 2, r);
  assert((await at("tq"))?.jobId === "job-tqs", "tq is locked");
  assert((await at("twl")) === null, "twl stays editable (issue #352)");
  assert((await at("tn")) === null, "tn stays editable");
  assert((await at("verse")) === null, "scripture stays editable");
}

// ─── Each pipeline locks its own resource ─────────────────────────────────
{
  console.log("\n[per-pipeline scope]");
  const notes = fakeEnv([job("notes")]);
  assert((await activePipelineForChapter(notes, "ZEC", 2, "tn")) !== null, "notes run locks tn");
  assert((await activePipelineForChapter(notes, "ZEC", 2, "tq")) === null, "notes run leaves tq open");
  assert(
    (await activePipelineForChapter(notes, "ZEC", 2, "verse")) === null,
    "notes run leaves scripture open",
  );

  const gen = fakeEnv([job("generate")]);
  assert((await activePipelineForChapter(gen, "ZEC", 2, "verse")) !== null, "generate run locks scripture");
  assert((await activePipelineForChapter(gen, "ZEC", 2, "tn")) === null, "generate run leaves tn open");
}

// ─── The chapter macro locks the whole chain, not just the running step ────
// "Generate everything" = generate → notes → tqs, one job at a time with the
// rest parked on follow_up_chain. Migration 0012: "chapter lock holds across
// the full run" — an edit made during the generate step would otherwise be
// overwritten when the chained notes/tqs steps land.
{
  console.log("\n[chained macro]");
  const chain = JSON.stringify([{ pipelineType: "notes" }, { pipelineType: "tqs" }]);
  const env = fakeEnv([job("generate", "running", chain)]);
  const at = (r) => activePipelineForChapter(env, "ZEC", 2, r);
  assert((await at("verse")) !== null, "running generate step locks scripture");
  assert((await at("tn")) !== null, "pending notes step locks tn");
  assert((await at("tq")) !== null, "pending tqs step locks tq");
  assert((await at("twl")) === null, "twl still never locks");

  const locked = resourcesLockedByJob("generate", chain);
  assert(locked.has("verse") && locked.has("tn") && locked.has("tq"), "chain union covers every step");
  assert(!locked.has("twl"), "chain union never adds twl");
}

// ─── Unknown pipeline types fail CLOSED ───────────────────────────────────
{
  console.log("\n[unknown type fails closed]");
  assert(resourcesWrittenBy("realign").length === 4, "unrecognized type writes everything");
  const env = fakeEnv([job("realign")]);
  for (const r of ["verse", "tn", "tq", "twl"]) {
    assert((await activePipelineForChapter(env, "ZEC", 2, r)) !== null, `unknown type locks ${r}`);
  }
  const bad = resourcesLockedByJob("notes", "{not json");
  assert(bad.size === 4, "unparseable chain JSON fails closed");
}

// ─── TWL is never locked by a known pipeline ──────────────────────────────
{
  console.log("\n[twl never locks]");
  const all = fakeEnv([job("generate"), job("notes"), job("tqs")]);
  assert((await activePipelineForChapter(all, "ZEC", 2, "twl")) === null, "all three running → twl open");
}

// ─── Queued jobs never lock; scope + terminal states still respected ──────
{
  console.log("\n[state and scope]");
  const queued = fakeEnv([job("tqs", "queued")]);
  assert((await activePipelineForChapter(queued, "ZEC", 2, "tq")) === null, "queued tqs does not lock tq");

  const done = fakeEnv([job("tqs", "done")]);
  assert((await activePipelineForChapter(done, "ZEC", 2, "tq")) === null, "finished tqs does not lock");

  const running = fakeEnv([job("tqs")]);
  assert(
    (await activePipelineForChapter(running, "ZEC", 9, "tq")) === null,
    "chapter outside the job range is not locked",
  );
  assert(
    (await activePipelineForChapter(running, "HOS", 2, "tq")) === null,
    "another book is not locked",
  );
}

// ─── The right job is reported when two runs overlap ──────────────────────
{
  console.log("\n[two concurrent runs]");
  const gen = { ...job("generate"), created_at: 900 };
  const tqs = { ...job("tqs"), created_at: 1500 };
  const env = fakeEnv([gen, tqs]);
  assert(
    (await activePipelineForChapter(env, "ZEC", 2, "tq"))?.jobId === "job-tqs",
    "tq reports the tqs job, not the older generate job",
  );
  assert(
    (await activePipelineForChapter(env, "ZEC", 2, "verse"))?.jobId === "job-generate",
    "verse reports the generate job",
  );
}

// ─── No resource argument keeps the old global behavior (book reimport) ───
{
  console.log("\n[resource omitted → global]");
  const env = fakeEnv([job("tqs")]);
  assert(
    (await activePipelineForChapter(env, "ZEC", 2))?.jobId === "job-tqs",
    "any running job answers the unscoped question",
  );
}


// ─── The set form the reimport uses (issue #828) ──────────────────────────
//
// The nightly reimport asks "which resources are locked in this chapter" once
// and answers for all five export resources. Before #828 it asked the
// RESOURCE-BLIND question and withheld every resource's watermark, so a JER 25
// `tqs` run held back TN, ULT and UST — the three resources it does not write —
// and the export skipped them as stale for a whole night.
{
  console.log("\n[lockedResourcesForChapter]");
  const set = (s) => [...s].sort().join(",");

  assert(set(await lockedResourcesForChapter(fakeEnv([job("tqs")]), "ZEC", 2)) === "tq",
    "a questions run locks tq and nothing else");
  assert(set(await lockedResourcesForChapter(fakeEnv([job("notes")]), "ZEC", 2)) === "tn",
    "a notes run locks tn only");
  assert(set(await lockedResourcesForChapter(fakeEnv([job("generate")]), "ZEC", 2)) === "verse",
    "a generate run locks verse only");
  assert(set(await lockedResourcesForChapter(fakeEnv([job("tqs"), job("generate")]), "ZEC", 2)) === "tq,verse",
    "two running jobs union their locks");

  // Fail-closed, both shapes — an unknown pipeline type and an unparseable
  // chain each lock everything, exactly as resourcesLockedByJob does.
  assert(set(await lockedResourcesForChapter(fakeEnv([job("brand-new-kind")]), "ZEC", 2)) === "tn,tq,twl,verse",
    "an unrecognized pipeline type locks every resource");
  assert(set(await lockedResourcesForChapter(fakeEnv([job("notes", "running", "{not json")]), "ZEC", 2)) === "tn,tq,twl,verse",
    "an unparseable follow_up_chain locks every resource");

  // A chained run locks what the chain will still write.
  const chained = job("generate", "running", JSON.stringify([{ pipelineType: "notes" }]));
  assert(set(await lockedResourcesForChapter(fakeEnv([chained]), "ZEC", 2)) === "tn,verse",
    "a chained generate→notes run locks verse and tn");

  // Nothing running, wrong chapter, wrong book, terminal state → empty.
  assert(set(await lockedResourcesForChapter(fakeEnv([]), "ZEC", 2)) === "",
    "no jobs → nothing locked");
  assert(set(await lockedResourcesForChapter(fakeEnv([job("tqs", "done")]), "ZEC", 2)) === "",
    "a finished job locks nothing");
  assert(set(await lockedResourcesForChapter(fakeEnv([job("tqs")]), "ZEC", 9)) === "",
    "a job on chapters 1-3 does not lock chapter 9");
  assert(set(await lockedResourcesForChapter(fakeEnv([job("tqs")]), "HOS", 2)) === "",
    "a JER job does not lock another book");
}

// ─── A chained macro stays locked for what EARLIER links already wrote ────
//
// enqueueFollowUpFromChain pops the chain head, so the last link of a
// generate→notes→tqs macro carries follow_up_chain = null and its own
// pipeline_type alone. The verses and notes the earlier links wrote are in D1
// and have NOT been exported yet — the export runs after the nightly reimport —
// so answering `{tq}` would let that same night's sync overwrite the new ULT
// with master's older revision and let the tombstone prune soft-delete the
// AI's new tn rows. The links share a job_id root.
{
  console.log("\n[chain lineage keeps finished links locked]");
  const set = (s) => [...s].sort().join(",");
  const link = (id, type, state, chain = null) => ({
    ...job(type, state, chain),
    job_id: id,
  });

  const macro = [
    link("j1", "generate", "done", JSON.stringify([{ pipelineType: "notes" }, { pipelineType: "tqs" }])),
    link("j1:chain1", "notes", "done", JSON.stringify([{ pipelineType: "tqs" }])),
    link("j1:chain2", "tqs", "running", null),
  ];
  assert(set(await lockedResourcesForChapter(fakeEnv(macro), "ZEC", 2)) === "tn,tq,verse",
    "the last link still locks the verses and notes its earlier links wrote");

  // Mid-macro: the notes link is running, generate already wrote verses.
  const midMacro = [
    link("j1", "generate", "done", JSON.stringify([{ pipelineType: "notes" }, { pipelineType: "tqs" }])),
    link("j1:chain1", "notes", "running", JSON.stringify([{ pipelineType: "tqs" }])),
  ];
  assert(set(await lockedResourcesForChapter(fakeEnv(midMacro), "ZEC", 2)) === "tn,tq,verse",
    "mid-macro locks the finished generate plus the pending tqs");

  // A finished link of a macro that is fully done locks nothing.
  const finished = [
    link("j1", "generate", "done", null),
    link("j1:chain1", "notes", "done", null),
  ];
  assert(set(await lockedResourcesForChapter(fakeEnv(finished), "ZEC", 2)) === "",
    "a completed macro locks nothing");

  // An unrelated job that merely shares a prefix is not a chain link.
  const unrelated = [
    link("j1", "tqs", "running", null),
    link("j10", "generate", "done", null),
  ];
  assert(set(await lockedResourcesForChapter(fakeEnv(unrelated), "ZEC", 2)) === "tq",
    "a different job id is not swept in by prefix");

  assert(chainRootJobId("j1:chain2") === "j1", "chainRootJobId strips the chain suffix");
  assert(chainRootJobId("j1") === "j1", "an unchained job is its own root");
  assert(chainRootJobId("j1:chain1:chain2") === "j1", "nesting strips at the FIRST suffix");
  assert(chainRootJobId("j1:followup") === "j1:followup", "a followup child is its own root");

  // The sibling lookup is the only extra D1 read this function can make, and
  // the nightly reimport calls it once per chapter of every book — a book-wide
  // job would otherwise double the run's lock reads against a subrequest budget
  // bookReimport.ts already documents as tight. It must fire only when an
  // active job is actually a chain LINK (an unchained job has no predecessors).
  const counting = (jobs) => {
    let queries = 0;
    const inner = fakeEnv(jobs);
    return {
      env: { DB: { prepare: (sql) => { queries++; return inner.DB.prepare(sql); } } },
      count: () => queries,
    };
  };
  const lone = counting([link("u-u-i-d", "tqs", "running", null)]);
  await lockedResourcesForChapter(lone.env, "ZEC", 2);
  assert(lone.count() === 1, "an unchained running job costs exactly one query");

  const quiet = counting([]);
  await lockedResourcesForChapter(quiet.env, "ZEC", 2);
  assert(quiet.count() === 1, "a chapter with nothing running costs exactly one query");

  const chained = counting([link("u-u-i-d:chain2", "tqs", "running", null)]);
  await lockedResourcesForChapter(chained.env, "ZEC", 2);
  assert(chained.count() === 2, "a running chain link pays the sibling lookup");
}

// ─── Export resource → lock namespace ─────────────────────────────────────
{
  console.log("\n[lockedResourceFor]");
  assert(lockedResourceFor("ult") === "verse", "ult lives in the verse lock");
  assert(lockedResourceFor("ust") === "verse", "ust lives in the verse lock");
  assert(lockedResourceFor("tn") === "tn", "tn is its own lock");
  assert(lockedResourceFor("tq") === "tq", "tq is its own lock");
  assert(lockedResourceFor("twl") === "twl", "twl is its own lock");
}

// ─── The reimport must never ask the resource-blind question (#828) ───────
//
// A source guard, deliberately: the three reimport call sites are inside a
// 10k-line file whose surrounding machinery (staged R2 plans, Workflow steps,
// live DCS fetches) cannot be stood up here, so the invariant is stated where
// it can actually be checked. What it asserts is exact — bookReimport.ts asks
// "which resources are locked", never "is anything running" — and it fails the
// moment a call site regresses to the blind form.
{
  console.log("\n[bookReimport asks the scoped question]");
  const src = readSourceSync(joinPath(dirName(toPath(import.meta.url)), "bookReimport.ts"), "utf8");
  assert(!/activePipelineForChapter\s*\(/.test(src),
    "bookReimport.ts makes no resource-blind activePipelineForChapter call");
  // >= 3, not == 3: the invariant is "no site asks the blind question" (the
  // assertion above), not "there are exactly three sites" — a legitimate fourth
  // call site should not fail a test about something else.
  assert((src.match(/lockedResourcesForChapter\s*\(/g) ?? []).length >= 3,
    "all three reimport lock sites use lockedResourcesForChapter");
  assert((src.match(/lockedResourceFor\s*\(/g) ?? []).length >= 3,
    "the lock sites map their resource through lockedResourceFor");
}

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall chapterLock assertions passed");
