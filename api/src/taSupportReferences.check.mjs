// Network check: every id in TA_SUPPORT_REFERENCE_IDS must resolve to a real
// article in unfoldingWord/en_ta. A dead id here is invisible otherwise — the
// export lint (SUPPORT_REFERENCE_RE in lint.ts) only validates rc:// *shape*,
// never membership, so a wrong slug is offered to translators, saved into
// tn_rows.support_reference, and exported to Door43 without a single warning.
// That is exactly how `grammar-connect-logic-reason` survived: no such article
// exists (the one article `grammar-connect-logic-result` covers both the reason
// and the result side of the relationship).
//
// This hits git.door43.org, so it is deliberately NOT in `npm test` — the unit
// suites in this repo are all offline and deterministic. It runs nightly via
// .github/workflows/ta-refs.yml, and on demand:
//
//   npm --workspace api run check:ta-refs
//
// One request, not one per id: we list the `translate/` tree once and compare
// sets, so a slow or rate-limited Door43 can't turn this into 95 round-trips.

import assert from "node:assert/strict";
import { TA_SUPPORT_REFERENCE_IDS } from "./taSupportReferences.ts";

const CONTENTS_URL =
  "https://git.door43.org/api/v1/repos/unfoldingWord/en_ta/contents/translate";

const res = await fetch(CONTENTS_URL, {
  headers: { accept: "application/json" },
});
if (!res.ok) {
  // An outage must not be reported as "your ids are wrong" — fail loudly but
  // distinguishably.
  console.error(`FETCH FAILED: ${CONTENTS_URL} -> HTTP ${res.status}`);
  process.exit(2);
}

const entries = await res.json();
const articles = new Set(
  entries.filter((e) => e.type === "dir").map((e) => e.name),
);

// Guard against a truncated / reshaped API response silently passing every id.
assert.ok(
  articles.size > 100,
  `en_ta translate/ listing looks truncated (${articles.size} dirs) — refusing to validate against it`,
);

const dead = TA_SUPPORT_REFERENCE_IDS.filter((id) => !articles.has(id));

if (dead.length > 0) {
  console.error(
    `\n${dead.length} support-reference id(s) do not exist in unfoldingWord/en_ta translate/:\n`,
  );
  for (const id of dead) console.error(`  - ${id}`);
  console.error(
    "\nRemove or correct them in api/src/taSupportReferences.ts. Do not guess a\n" +
      "near-miss replacement: a wrong id changes the meaning of every note that\n" +
      "carries it.\n",
  );
  process.exit(1);
}

console.log(
  `  ok - all ${TA_SUPPORT_REFERENCE_IDS.length} support-reference ids resolve in en_ta (${articles.size} articles available)`,
);
