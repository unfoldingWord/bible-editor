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
  resourcesLockedByJob,
  resourcesWrittenBy,
} from "./chapterLock.ts";

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
        if (!/state IN \(\?3, \?4, \?5, \?6\)/.test(sql)) {
          throw new Error(`unexpected state predicate in SQL:\n${sql}`);
        }
        if (/pipeline_type\s+IN/.test(sql)) {
          throw new Error("SQL must not filter pipeline_type — chain steps are matched in JS");
        }
        return {
          bind(book, chapter, ...states) {
            const allowed = new Set(states);
            return {
              async all() {
                return {
                  results: jobs
                    .filter(
                      (j) =>
                        j.book === book &&
                        j.start_chapter <= chapter &&
                        j.end_chapter >= chapter &&
                        allowed.has(j.state),
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

if (failed) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nall chapterLock assertions passed");
