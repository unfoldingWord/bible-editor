// The footnotes (`\f … \f*`) of one verse, shown under its editable line in
// the active card. Footnote bodies are invisible to the verse's
// contentEditable (extractEditableText never reads a note's `content`), so this
// band is where a translator sees, edits, or deletes them. Each change is a
// structural swap of that one footnote node (lib/footnotes.ts editFootnote),
// saved by Shell.saveFootnoteEdit through the normal verse outbox — no word or
// alignment milestone is touched.
//
// The body is edited as raw USFM (`+ \ft Or \fqa beginning\fqa*.`), the same
// way the verse line shows `\q1` / `\p` tokens: the band does not hide the
// footnote's internal markers. Edit and delete are disabled while the verse
// has unsaved typing, so a footnote save can never race the pending text save
// on the same verse.

import { useEffect, useRef, useState } from "react";
import { Box, IconButton, Stack, TextField, Tooltip, Typography } from "@mui/material";
import EditIcon from "@mui/icons-material/Edit";
import CheckIcon from "@mui/icons-material/Check";
import CloseIcon from "@mui/icons-material/Close";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import { footnoteContentError, type FootnoteInfo } from "../lib/footnotes";

interface Props {
  footnotes: FootnoteInfo[];
  editable?: boolean;
  // Set while the verse line holds unsaved typing: edits are blocked until it
  // is saved, with this as the reason shown on the buttons.
  blockedReason?: string | null;
  onChange?: (change: { index: number; content: string | null }) => void;
}

export function FootnoteBand({ footnotes, editable, blockedReason, onChange }: Props) {
  if (footnotes.length === 0) return null;
  return (
    <Stack spacing={0.25} sx={{ mt: 0.5 }} data-testid="footnote-band">
      {footnotes.map((f) => (
        <FootnoteRow
          // The body is part of the key so a saved / remote change resets an
          // open editor to the new text.
          key={`${f.index}-${f.content}`}
          note={f}
          editable={!!editable && !!onChange}
          blockedReason={blockedReason ?? null}
          onChange={(content) => onChange?.({ index: f.index, content })}
        />
      ))}
    </Stack>
  );
}

function FootnoteRow({
  note,
  editable,
  blockedReason,
  onChange,
}: {
  note: FootnoteInfo;
  editable: boolean;
  blockedReason: string | null;
  onChange: (content: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.content);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);
  const error = editing ? footnoteContentError(draft) : null;
  const commit = () => {
    if (error) return;
    setEditing(false);
    if (draft.trim() !== note.content) onChange(draft.trim());
  };
  const cancel = () => {
    setDraft(note.content);
    setEditing(false);
  };
  const blocked = !!blockedReason;
  const label = note.tag === "fe" ? "Endnote" : "Footnote";
  return (
    <Box
      data-testid="footnote-row"
      sx={{
        display: "flex",
        alignItems: editing ? "flex-start" : "center",
        gap: 0.5,
        px: 1,
        py: 0.25,
        borderLeft: "3px solid",
        borderColor: "info.light",
        bgcolor: "action.hover",
        borderRadius: 0.5,
        fontSize: 13,
      }}
    >
      <Typography
        component="span"
        sx={{ fontFamily: "monospace", fontSize: 12, color: "text.secondary", flexShrink: 0, pt: editing ? 1 : 0 }}
        title={label}
      >
        \{note.tag}
      </Typography>
      {editing ? (
        <TextField
          inputRef={inputRef}
          size="small"
          fullWidth
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancel();
            }
          }}
          error={!!error}
          helperText={error ?? "Raw USFM between \\f and \\f* — e.g. + \\ft Or \\fqa another reading\\fqa*."}
          inputProps={{ "aria-label": `${label} text`, style: { fontFamily: "monospace", fontSize: 13 } }}
        />
      ) : (
        <Typography
          component="span"
          sx={{ flex: 1, minWidth: 0, fontSize: 13, color: "text.primary", fontStyle: note.text ? "normal" : "italic" }}
          title={note.content}
        >
          {note.text || "(empty footnote)"}
        </Typography>
      )}
      {editable && (
        <Stack direction="row" spacing={0} sx={{ flexShrink: 0 }}>
          {editing ? (
            <>
              <Tooltip title="Save footnote (Enter)">
                <span>
                  <IconButton size="small" aria-label={`Save ${label.toLowerCase()}`} onClick={commit} disabled={!!error}>
                    <CheckIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title="Cancel (Esc)">
                <IconButton size="small" aria-label="Cancel" onClick={cancel}>
                  <CloseIcon fontSize="small" />
                </IconButton>
              </Tooltip>
            </>
          ) : (
            <>
              <Tooltip title={blockedReason ?? `Edit ${label.toLowerCase()}`}>
                <span>
                  <IconButton
                    size="small"
                    aria-label={`Edit ${label.toLowerCase()}`}
                    disabled={blocked}
                    onClick={() => {
                      setDraft(note.content);
                      setEditing(true);
                    }}
                  >
                    <EditIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title={blockedReason ?? `Delete ${label.toLowerCase()}`}>
                <span>
                  <IconButton
                    size="small"
                    aria-label={`Delete ${label.toLowerCase()}`}
                    disabled={blocked}
                    onClick={() => onChange(null)}
                  >
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            </>
          )}
        </Stack>
      )}
    </Box>
  );
}
