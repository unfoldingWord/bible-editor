import { expect, test, request as apiRequest } from "@playwright/test";
import { mintToken, newUserContext, gotoVerse, noteTextarea } from "./helpers";

const BASE = process.env.BE_BASE_URL ?? "http://localhost:5173";

// S11 — A single click on an INACTIVE note's body must land the cursor in the
// editable textarea, not just activate the card (#725).
//
// Root cause: the card's own activation (Paper's onMouseDown -> onFocus ->
// active=true) alone already flips `showReadView` false (see NoteCard.tsx),
// since showReadView = !editingBody && !active. The read view's edit-intent
// (its onClick -> setEditingBody(true)) fired on the LATER click event, by
// which point the read view — and the onClick handler bound to it — had
// already unmounted. The first click was wasted; a second click (now landing
// on the freshly-mounted, unfocused textarea) was needed to actually start
// editing. The fix moves the read view's edit-intent to its own onMouseDown,
// mirroring the note-link fix (#715/#717), so activation and entering edit
// mode land in the same React commit.
test("single click on an inactive note body focuses the editable textarea", async ({
  browser,
}) => {
  // Seed a throwaway row so we don't mutate the shared fixture.
  const setupCtx = await apiRequest.newContext({ baseURL: BASE });
  const setupAuth = await mintToken(setupCtx, "alice");
  const createRes = await setupCtx.post(`/api/rows/tn`, {
    headers: {
      Authorization: `Bearer ${setupAuth.token}`,
      "x-csrf-token": setupAuth.csrf,
      "Content-Type": "application/json",
    },
    data: {
      book: "ZEC",
      chapter: 8,
      verse: 1,
      ref_raw: "8:1",
      note: `single-click-edit-test ${Date.now()}`,
    },
  });
  expect(createRes.status()).toBe(201);
  const created = await createRes.json();
  await setupCtx.dispose();

  const { context } = await newUserContext(browser, "carol");
  const page = await context.newPage();
  await gotoVerse(page, "ZEC", 8, 1);

  const card = page.locator(`[data-note-id="${created.id}"]`);
  await card.waitFor({ timeout: 10_000 });

  // The card starts inactive: the body renders as the plain-text read view,
  // not the editable textarea.
  const readBody = card.getByTitle("click to edit");
  await expect(readBody).toBeVisible();

  // A single click must both activate the card AND enter edit mode.
  await readBody.click();
  await expect(noteTextarea(page, created.id)).toBeFocused();

  await context.close();
});
