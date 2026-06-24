// Emit the Isa 38 intro update: adapt the 2 Kings 20 introduction (figs/illness)
// onto the pristine Isaiah 38 intro (cgq6), minimal pass, flagged for review.
// Newlines are stored as the literal two-char escape \n (TSV convention), so the
// note string below uses literal "\\n". OFFLINE.
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, "out/kings-isa");
const NL = "\\n"; // literal backslash-n, as stored
const note = [
  "# Isaiah 38 Introduction",
  "## Structure and Formatting",
  "This chapter records the illness of Hezekiah, one of the great kings of Judah. It describes his prayer when he was near death, and Yahweh's promise to heal him and add fifteen years to his life. The same events are described in the parallel account in 2 Kings 20:1-11. Verses 9-20 are a song of thanksgiving that Hezekiah wrote after he recovered; some translations set these lines farther to the right than the rest of the text because they are poetry.",
  "## Religious and Cultural Concepts in This Chapter",
  "### Why did Isaiah say to put figs on Hezekiah's sore?",
  "In the ancient world, figs were a known remedy for sores and boils. Figs contain natural compounds and enzymes that have anti-inflammatory, soothing, and drawing effects. These can help bring a festering boil to a head and reduce swelling and infection. However, Hezekiah was so ill that he was near death, so it was improbable that the effects of the figs alone would have cured him. So agreeing to have his servants put the figs on his sore anyway was therefore an act of faith, trust, and obedience by Hezekiah. It showed that he was prepared to follow the instructions of Yahweh's prophet, even if it did not seem that the measures he specified would be sufficient. Isaiah had the king's servants use the best means available, so that they and he and the king were doing their part. But Hezekiah ultimately had to trust Yahweh for his healing.",
].join(NL + NL);

const reason = "Intro adapted from the 2 Kings 20 introduction (minimal pass) — verify wording and the '2 Kings 20:1-11' parallel reference.";
const payload = JSON.stringify({ book: "ISA", chapter: 38, verse: 0, ref_raw: "38:intro", note, source_note: "intro adapted from 2Ki 20:intro" });
const esc = (s) => s.replace(/'/g, "''");
const sql = [
  `UPDATE tn_rows SET note='${esc(note)}', review_kind='adapted-intro', review_reason='${esc(reason)}', updated_by=2, version=version+1, updated_at=unixepoch() WHERE book='ISA' AND id='cgq6' AND verse=0 AND deleted_at IS NULL;`,
  `INSERT INTO edit_log (kind,row_key,book,user_id,prev_version,new_version,action,source,payload_json) VALUES ('tn','cgq6','ISA',2,NULL,NULL,'update','parallel_migration','${esc(payload)}');`,
].join("\n");
writeFileSync(resolve(outDir, "intro-38.sql"), sql + "\n");
console.log("wrote intro-38.sql; note length:", note.length);
