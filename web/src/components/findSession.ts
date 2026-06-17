// Module-level find session — survives Shell remounts.
//
// Walking find matches across chapters in book mode navigates via the URL
// (the resource column is bound to one chapter via useChapter), and Shell is
// keyed on book/chapter/verse in App.tsx, so each cross-chapter jump remounts
// Shell. React state inside Shell (the find overlay's open flag, query, and
// position) is lost on that remount, which made the find box vanish mid-walk.
//
// Keeping the session here — a plain module singleton, like Shell's
// `pendingNoteJump` — lets the overlay re-open with the same query and
// position after the remount, so next/prev continues seamlessly. The
// remount's note activation + scroll is already handled by Shell's
// pendingNoteJump path; this only restores the overlay around it.
//
// `scope` is intentionally absent: the overlay already persists it to
// localStorage (be:find-scope). Cleared on explicit close (see ScriptureColumn
// closeFind) so a fresh open starts clean.
export interface FindSession {
  open: boolean;
  find: string;
  replace: string;
  regex: boolean;
  caseSensitive: boolean;
  strongs: boolean;
  activeIdx: number;
}

export const findSession: FindSession = {
  open: false,
  find: "",
  replace: "",
  regex: false,
  caseSensitive: false,
  strongs: false,
  activeIdx: 0,
};

export function resetFindSession(): void {
  findSession.open = false;
  findSession.find = "";
  findSession.replace = "";
  findSession.regex = false;
  findSession.caseSensitive = false;
  findSession.strongs = false;
  findSession.activeIdx = 0;
}
