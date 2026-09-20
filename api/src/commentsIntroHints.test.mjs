// Regression tests for resolveIntroHintComments (issue #819) — the
// server-triggered counterpart to POST /:id/comments/resolve that consumes a
// chapter's intro-hint comments once they've been folded into an outbound
// notes-pipeline run, so they don't get re-sent on every future
// regeneration.
//
// Run from api/:
//   node --experimental-strip-types --import ./src/tsResolveHook.mjs --no-warnings src/commentsIntroHints.test.mjs
//
// (comments.ts imports "./auth" and "./mentions" without an extension —
// bundler-style, resolved by Wrangler/esbuild but not Node's ESM loader —
// hence tsResolveHook.mjs; see run-tests.mjs's EXTRA_IMPORTS.)
//
// Not a test framework; a failed assert exits non-zero. Fake-D1-stub pattern
// mirrors chapterLock.test.mjs / pipelinesForceFail.test.mjs: every assertion
// here is a SQL-text-and-in-memory-filter check, proving the guards weren't
// deleted — not a real SQLite engine's three-valued NULL semantics.

import { resolveIntroHintComments } from "./comments.ts";

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`  ok: ${msg}`);
  }
}

function commentRow(overrides) {
  return {
    id: 1,
    book: "ZEC",
    chapter: 3,
    verse: 0,
    row_kind: null,
    row_id: null,
    parent_id: null,
    kind: "note",
    body: "Mention the covenant theme.",
    mentions_json: null,
    author_id: 5,
    author_name: "Editor One",
    created_at: 100,
    updated_at: 100,
    resolved_at: null,
    resolved_by: null,
    resolved_by_name: null,
    deleted_at: null,
    ...overrides,
  };
}

// Minimal D1 stand-in: an in-memory row list the UPDATE mutates in place and
// the SELECT (loadComment's SELECT_COMMENT) reads back from, plus a record of
// every SQL string issued so the guard clauses can be asserted present.
function fakeDb(rows) {
  const queries = [];
  return {
    queries,
    prepare(sql) {
      queries.push(sql);
      return {
        bind(...args) {
          return {
            async run() {
              if (!/UPDATE comments SET resolved_at = unixepoch\(\)/.test(sql)) {
                throw new Error(`unexpected run() query:\n${sql}`);
              }
              if (!/resolved_by = \?1/.test(sql)) {
                throw new Error("UPDATE must bind resolved_by positionally as ?1");
              }
              if (!/AND deleted_at IS NULL AND resolved_at IS NULL/.test(sql)) {
                throw new Error("UPDATE must guard on deleted_at/resolved_at — else it could clobber an already-resolved or deleted comment");
              }
              const [userId, ...ids] = args;
              for (const row of rows) {
                if (ids.includes(row.id) && row.deleted_at == null && row.resolved_at == null) {
                  row.resolved_at = 999;
                  row.resolved_by = userId;
                  row.resolved_by_name = `user-${userId}`;
                  row.updated_at = 999;
                }
              }
              return { success: true };
            },
            async first() {
              if (!/SELECT c\.\*/.test(sql) || !/WHERE c\.id = \?1/.test(sql)) {
                throw new Error(`unexpected first() query:\n${sql}`);
              }
              const [id] = args;
              const row = rows.find((r) => r.id === id);
              return row ? { ...row } : null;
            },
          };
        },
      };
    },
  };
}

// ─── happy path ──────────────────────────────────────────────────────────────
{
  console.log("\n[resolveIntroHintComments: happy path]");
  const rows = [commentRow({ id: 10, chapter: 3 }), commentRow({ id: 11, chapter: 3, body: "Second note." })];
  const db = fakeDb(rows);
  const resolved = await resolveIntroHintComments(db, [10, 11], 42);

  assert(rows[0].resolved_at === 999 && rows[0].resolved_by === 42, "row 10 stamped resolved by the triggering user");
  assert(rows[1].resolved_at === 999 && rows[1].resolved_by === 42, "row 11 stamped resolved by the triggering user");
  assert(resolved.length === 2, "returns one CommentDto per resolved id");
  assert(
    resolved.every((c) => c.resolvedBy === 42),
    "returned DTOs already reflect the resolution (caller doesn't need a second read)",
  );
  assert(
    new Set(resolved.map((c) => c.id)).size === 2,
    "no duplicate ids in the returned set",
  );
}

// ─── empty input short-circuits ─────────────────────────────────────────────
{
  console.log("\n[resolveIntroHintComments: empty ids]");
  const db = fakeDb([]);
  const resolved = await resolveIntroHintComments(db, [], 42);
  assert(resolved.length === 0, "empty ids returns empty array");
  assert(db.queries.length === 0, "empty ids issues no D1 query at all");
}

// ─── guards: already-resolved and deleted rows are never re-stomped ─────────
{
  console.log("\n[resolveIntroHintComments: guards]");
  const alreadyResolved = commentRow({ id: 20, resolved_at: 500, resolved_by: 7, resolved_by_name: "user-7" });
  const softDeleted = commentRow({ id: 21, deleted_at: 600 });
  const rows = [alreadyResolved, softDeleted];
  const db = fakeDb(rows);
  await resolveIntroHintComments(db, [20, 21], 99);

  assert(
    alreadyResolved.resolved_by === 7,
    "a comment already resolved by someone else is not reassigned to the pipeline-triggering user",
  );
  assert(softDeleted.resolved_at == null, "a soft-deleted comment is never marked resolved");
}

if (failed > 0) {
  console.error(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log("\nAll assertions passed.");
