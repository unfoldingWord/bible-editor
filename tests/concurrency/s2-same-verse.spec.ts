import { expect, test, request as apiRequest } from "@playwright/test";
import { fetchChapter, saveNote, gotoVerse, mintToken, newUserContext, openNoteEditor, waitForServerNote } from "./helpers";

// Honor BE_BASE_URL so the suite runs on a relocated port (mirrors s8).
const BASE = process.env.BE_BASE_URL ?? "http://localhost:5173";


// S2 — Two users edit DIFFERENT notes on the SAME verse simultaneously.
// Same shape as S1 but tightens the assertion to catch verse-level (rather
// than row-level) lock leaks. The seed has multiple notes on ZEC 6:1 so we
// can pick two distinct rows on the same verse.
test("two users editing different notes on the same verse both land", async ({ browser }) => {
  const probe = await apiRequest.newContext({ baseURL: BASE });
  const probeAuth = await mintToken(probe, "probe");
  const chapter = await fetchChapter(probe, probeAuth.token, "ZEC", 6);

  const v1Notes = chapter.tn.filter((r) => r.verse === 1);
  expect(v1Notes.length, "expected at least two TN rows on ZEC 6:1").toBeGreaterThanOrEqual(2);
  const aliceTarget = v1Notes[0];
  const bobTarget = v1Notes[1];
  await probe.dispose();

  const { context: aliceCtx } = await newUserContext(browser, "alice");
  const { context: bobCtx } = await newUserContext(browser, "bob");
  const alice = await aliceCtx.newPage();
  const bob = await bobCtx.newPage();

  // Both users on the same verse, so both gotoVerse(...,1) — both note
  // cards mount in each user's resource column.
  await Promise.all([
    gotoVerse(alice, "ZEC", 6, aliceTarget.verse),
    gotoVerse(bob, "ZEC", 6, bobTarget.verse),
  ]);

  // Inactive cards show a click-to-edit read view; open each editor first.
  const [aliceNote, bobNote] = await Promise.all([
    openNoteEditor(alice, aliceTarget.id),
    openNoteEditor(bob, bobTarget.id),
  ]);

  const aliceText = `ALICE v1 ${Date.now()}`;
  const bobText = `BOB v1 ${Date.now()}`;
  await Promise.all([aliceNote.fill(aliceText), bobNote.fill(bobText)]);

  // Save both edits — notes persist in the draft cache until Save is clicked
  // (no autosave). Each user saves their own card; the PATCHes race through
  // the outbox.
  await Promise.all([
    saveNote(alice, aliceTarget.id),
    saveNote(bob, bobTarget.id),
  ]);

  const serverCtx = await apiRequest.newContext({ baseURL: BASE });
  const serverAuth = await mintToken(serverCtx, "verifier");
  const [aliceFinal, bobFinal] = await Promise.all([
    waitForServerNote(serverCtx, serverAuth.token, "ZEC", 6, aliceTarget.id, (n) => n === aliceText),
    waitForServerNote(serverCtx, serverAuth.token, "ZEC", 6, bobTarget.id, (n) => n === bobText),
  ]);

  expect(aliceFinal.note).toBe(aliceText);
  expect(bobFinal.note).toBe(bobText);
  // Neither row should have stolen the other's text.
  expect(aliceFinal.note).not.toContain("BOB");
  expect(bobFinal.note).not.toContain("ALICE");

  await serverCtx.dispose();
  await aliceCtx.close();
  await bobCtx.close();
});
