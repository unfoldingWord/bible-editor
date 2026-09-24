// Guard for scripts/d1-select.mjs: is this SQL one read-only statement?
//
// D1 runs EVERY statement in a `--command` string, so a permission rule that
// only matches a leading "SELECT" would also let "SELECT 1; DELETE FROM verses"
// through. This guard is what makes it safe to allowlist d1-select.mjs for
// agents. It fails closed: anything it cannot prove is a single SELECT /
// WITH…SELECT / EXPLAIN is refused, even when it would have been harmless.
//
// Tests: scripts/lib/readOnlySql.test.mjs (`npm run test:scripts`).

// Keywords that write, change schema or session state, or reach outside the
// database. Matched as whole words outside string literals and comments, so a
// column like `deleted_at` or a value like 'DELETE' does not trip it.
const FORBIDDEN = [
  "INSERT", "UPDATE", "DELETE", "UPSERT", "MERGE",
  "DROP", "ALTER", "CREATE", "TRUNCATE", "RENAME",
  "ATTACH", "DETACH", "VACUUM", "REINDEX", "ANALYZE", "PRAGMA",
  "BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE", "TRANSACTION",
];
const FORBIDDEN_RE = new RegExp(`\\b(${FORBIDDEN.join("|")})\\b`, "i");
// REPLACE is a statement (REPLACE INTO …) and a scalar function replace(x, a, b).
// The statement form is never followed by "(", so only that form is refused.
const REPLACE_STMT_RE = /\bREPLACE\b(?!\s*\()/i;
// Cheap ways to burn D1 CPU without writing: an unbounded recursive CTE or a
// huge generated blob. A CPU-limit hit can reset the prod DB (STATE.md, 7429),
// and this script runs without a human in the loop. A big cross join still
// passes; keep queries narrow.
const EXPENSIVE_RE = /\b(RECURSIVE|randomblob|zeroblob)\b/i;
const LEADING_RE = /^(SELECT|WITH|EXPLAIN)\b/i;

// Blank out string literals, quoted identifiers and comments, keeping length.
// Returns null if a literal or block comment is left unterminated.
function stripLiterals(sql) {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) return null;
        if (sql[j] === close) {
          if (close !== "]" && sql[j + 1] === close) { j += 2; continue; } // doubled quote escape
          break;
        }
        j++;
      }
      out += " ".repeat(j - i + 1);
      i = j + 1;
    } else if (ch === "-" && sql[i + 1] === "-") {
      const j = sql.indexOf("\n", i);
      const end = j === -1 ? sql.length : j;
      out += " ".repeat(end - i);
      i = end;
    } else if (ch === "/" && sql[i + 1] === "*") {
      const j = sql.indexOf("*/", i + 2);
      if (j === -1) return null;
      out += " ".repeat(j + 2 - i);
      i = j + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

// null when `sql` is one read-only statement, else the reason it is refused.
export function readOnlySqlProblem(sql) {
  if (typeof sql !== "string" || sql.trim() === "") return "empty SQL";
  // Belt and braces for the wrangler argv: never let the SQL look like a flag.
  if (sql.trimStart().startsWith("-")) return "must not start with '-'";
  const bare = stripLiterals(sql);
  if (bare === null) return "unterminated string literal or comment";
  const body = bare.trim().replace(/;\s*$/, "");
  if (body.includes(";")) return "more than one statement";
  if (!LEADING_RE.test(body)) return "must start with SELECT, WITH or EXPLAIN";
  const bad = body.match(FORBIDDEN_RE);
  if (bad) return `forbidden keyword ${bad[1].toUpperCase()}`;
  if (REPLACE_STMT_RE.test(body)) return "forbidden keyword REPLACE";
  const costly = body.match(EXPENSIVE_RE);
  if (costly) return `refused as potentially expensive: ${costly[1].toUpperCase()}`;
  return null;
}
