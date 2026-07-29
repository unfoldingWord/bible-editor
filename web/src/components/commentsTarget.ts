// What a comment thread is attached to, and the prop contract shared between
// Shell (which owns the state), the badges (which open the popover), and
// CommentsPopover (which renders the thread). Kept in its own module so the
// badge components don't have to import the popover just for its types.

import type { CommentKind, CommentRowKind } from "../sync/api";

// A verse anchor has no row; a row anchor carries the verse too so the popover
// can title itself and so a reply inherits the right reference.
export type CommentTarget =
  | { verse: number; rowKind?: undefined; rowId?: undefined }
  | { verse: number; rowKind: CommentRowKind; rowId: string };

export function targetsMatch(a: CommentTarget | null, b: CommentTarget | null): boolean {
  if (!a || !b) return a === b;
  return a.verse === b.verse && a.rowKind === b.rowKind && a.rowId === b.rowId;
}

// What a badge needs to open a popover: the anchor element it was clicked from,
// plus what it's anchored to.
export type OpenCommentsFn = (anchorEl: HTMLElement, target: CommentTarget) => void;

// Draft of a new comment or reply. `parentId` set => reply (the server makes it
// inherit the parent's anchor and kind, so kind is ignored for replies).
export interface NewCommentDraft {
  kind: CommentKind;
  body: string;
  parentId?: number;
}
