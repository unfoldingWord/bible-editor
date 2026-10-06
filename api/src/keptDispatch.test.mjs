// dispatchNext and options.kept (issue #1152): a notes dispatch carries the
// kept list only when KEPT_NOTES_ENABLED is exactly "true"; generate and tqs
// never do; a resume never does; a list that cannot be built fails the job
// instead of dispatching without it.
// Run from api/: node --experimental-strip-types --no-warnings src/keptDispatch.test.mjs
import { dispatchNext, resumeOptionsFromJson } from "./pipelines.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failed++; } else console.log(`  ok: ${msg}`);
}

const TN_ROW = { id: "cyfz", book: "EZK", chapter: 40, verse: 3, ref_raw: "40:3", quote: "q", note: "n", support_reference: "rc://*/ta/man/translate/figs-metaphor", preserve: 1 };

function fakeEnv({ pipelineType, optionsJson = null, flag, tnRows = [TN_ROW], tnFails = false }) {
  const env = {
    BT_API_TOKEN: "tok",
    ...(flag === undefined ? {} : { KEPT_NOTES_ENABLED: flag }),
    queries: [],
    failCalls: [],
    DB: {
      prepare(sql) {
        env.queries.push(sql);
        const job = { job_id: "job-k", user_id: 1, pipeline_type: pipelineType, book: "EZK", start_chapter: 40, end_chapter: 40, session_key: "s", options_json: optionsJson };
        if (/SELECT dcs_username FROM users/.test(sql)) return { bind: () => ({ first: async () => ({ dcs_username: "translator" }) }) };
        if (/SELECT DISTINCT book FROM pipeline_jobs WHERE state = 'queued'/.test(sql)) return { all: async () => ({ results: [] }) };
        if (/SET state = 'dispatching', updated_at = unixepoch\(\)/.test(sql)) return { bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }) };
        if (/SELECT job_id, user_id, pipeline_type, book, start_chapter, end_chapter,[\s\S]*session_key, options_json/.test(sql)) {
          return { first: async () => job, bind: () => ({ first: async () => job }) };
        }
        if (/FROM tn_rows/.test(sql)) {
          return { bind: () => ({ all: async () => { if (tnFails) throw new Error("D1 down"); return { results: tnRows }; } }) };
        }
        if (/FROM edit_log/.test(sql)) return { bind: () => ({ all: async () => ({ results: [] }) }) };
        if (/SET state = 'failed', error_kind = \?2, error_message = \?3/.test(sql)) {
          return { bind: (...a) => ({ run: async () => { env.failCalls.push({ kind: a[1], message: a[2] }); return { meta: { changes: 1 } }; } }) };
        }
        if (/SET state = 'running', upstream_job_id = \?2/.test(sql)) return { bind: () => ({ run: async () => ({ meta: { changes: 1 } }) }) };
        return { bind: () => ({ run: async () => ({ meta: { changes: 0 } }), first: async () => null, all: async () => ({ results: [] }) }) };
      },
    },
  };
  return env;
}

const originalFetch = globalThis.fetch;
async function run(cfg) {
  const env = fakeEnv(cfg);
  let body = null;
  globalThis.fetch = async (_u, init) => { body = JSON.parse(init.body); return new Response(JSON.stringify({ jobId: "bot-1" }), { status: 200 }); };
  try { await dispatchNext(env); } finally { globalThis.fetch = originalFetch; }
  return { env, body };
}

console.log("\n[notes, flag on]");
{
  const { body } = await run({ pipelineType: "notes", flag: "true" });
  assert(Array.isArray(body?.options?.kept) && body.options.kept.length === 1, "notes dispatch carries options.kept");
  assert(JSON.stringify(body.options.kept[0]) === JSON.stringify({ rowId: "cyfz", ref: "40:3", supportReference: "rc://*/ta/man/translate/figs-metaphor", quote: "q" }), "entry has exactly rowId, ref, supportReference, quote");
}
{
  const { body } = await run({ pipelineType: "notes", flag: "true", optionsJson: JSON.stringify({ noIntro: true }) });
  assert(body.options.noIntro === true && body.options.kept.length === 1, "kept merges with the job's stored options");
}
{
  const hints = [{ rowId: "cyfz", verse: 3, quote: "", supportReference: null, seed: "s" }];
  const { body } = await run({ pipelineType: "notes", flag: "true", optionsJson: JSON.stringify({ hints }) });
  assert(body.options.kept === undefined && body.options.hints.length === 1, "a rowId that is also a hint is not sent as kept");
}
console.log("\n[notes, flag off or not exactly true]");
for (const flag of [undefined, "false", "TRUE", "1", ""]) {
  const { body } = await run({ pipelineType: "notes", flag });
  assert(!body || !body.options || body.options.kept === undefined, `flag ${JSON.stringify(flag)} → no kept`);
}
console.log("\n[other pipelines never carry it]");
for (const type of ["generate", "tqs"]) {
  const { body, env } = await run({ pipelineType: type, flag: "true" });
  assert(body && !body.options, `${type} → no options.kept`);
  assert(!env.queries.some((q) => /FROM tn_rows/.test(q)), `${type} → kept list never even queried`);
}
console.log("\n[a list that cannot be built fails the job]");
{
  const { body, env } = await run({ pipelineType: "notes", flag: "true", tnFails: true });
  assert(body === null, "nothing was sent upstream");
  assert(env.failCalls.length === 1 && /kept_notes_unavailable/.test(env.failCalls[0].message), "job failed with kept_notes_unavailable");
}
{
  const many = Array.from({ length: 3001 }, (_, i) => ({ ...TN_ROW, id: `a${(i + 1000).toString(36).padStart(3, "0")}` }));
  const { body, env } = await run({ pipelineType: "notes", flag: "true", tnRows: many });
  assert(body === null && /too many kept notes/.test(env.failCalls[0]?.message ?? ""), "over 3000 → job fails with a clear message, not truncated");
}
console.log("\n[resume]");
{
  const r = resumeOptionsFromJson(JSON.stringify({ noIntro: true, kept: [{ rowId: "cyfz" }], fresh: true }), "j");
  assert(r && r.kept === undefined && r.fresh === undefined && r.noIntro === true, "resumeOptionsFromJson strips kept (and fresh)");
}
if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log("keptDispatch tests passed");
