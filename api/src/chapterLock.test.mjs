// Regression test for the resource-scoped chapter lock. The bug (issue #352):
// a running "tqs" job locked the WHOLE chapter, so a translator who asked for
// AI questions could no longer edit word links, notes or scripture. A run may
// only lock what it will overwrite when it lands.
//
// Run from api/:
//   node --experimental-strip-types --no-warnings src/chapterLock.test.mjs
//
// Not a test framework; failures exit non-zero. Mirrors sortOrder.test.mjs.

import { activePipelineForChapter } from "./chapterLock.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

// Minimal D1 stand-in: records the SQL + bindings, then answers the query by
// filtering an in-memory job list the same way the real statement would. We
// only need the two predicates the function builds — state IN (...) and the
// optional pipeline_type IN (...).
function fakeEnv(jobs) {
  return {
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            const states = new Set(args.slice(2, 6));
            const types = args.length > 6 ? new Set(args.slice(6)) : null;
            const hasTypeClause = /pipeline_type IN/.test(sql);
            return {
              async first() {
                const [book, chapter] = args;
                const hit = jobs
                  .filter(
                    (j) =>
                      j.book === book &&
                      j.start_chapter <= chapter &&
                      j.end_chapter >= chapter &&
                      states.has(j.state) &&
                      (!hasTypeClause || types.has(j.pipeline_type)),
                  )
                  .sort((a, b) => a.created_at - b.created_at)[0];
                return hit ?? null;
              },
            };
          },
        };
      },
    },
  };
}

const job = (pipeline_type, state = "running") => ({
  job_id: `job-${pipeline_type}`,
  pipeline_type,
  user_id: 1,
  created_at: 1000,
  book: "ZEC",
  start_chapter: 1,
  end_chapter: 3,
  state,
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

// ─── TWL is never locked, whatever is running ─────────────────────────────
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
