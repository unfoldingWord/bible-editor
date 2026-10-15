// Always-visible "Back" control for the top bar. One click returns to the
// newest remembered spot (verse, and the note/question/word link if one was
// focused). A forward arrow appears once you have gone back. Press-and-hold,
// right-click, or the small arrow opens the whole history with a "you are
// here" line: places ahead of it above, places behind it below. See
// lib/navHistory.ts for what counts as a remembered spot.

import { useRef, useState, useSyncExternalStore } from "react";
import Button from "@mui/material/Button";
import ButtonGroup from "@mui/material/ButtonGroup";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import ListItemText from "@mui/material/ListItemText";
import Divider from "@mui/material/Divider";
import Tooltip from "@mui/material/Tooltip";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import { bookName } from "../lib/bookNames";
import { navHistory, type NavSpot } from "../lib/navHistory";

const HOLD_MS = 450;

const KIND_LABEL = { tn: "note", tq: "question", twl: "word link" } as const;

export function describeSpot(s: NavSpot): string {
  const where = s.chapter === 0 || s.verse === 0 ? `${s.chapter === 0 ? "" : `${s.chapter} `}intro` : `${s.chapter}:${s.verse}`;
  const place = `${bookName(s.book)} ${where}`;
  return s.kind ? `${place} · ${KIND_LABEL[s.kind]}` : place;
}

interface Props {
  // Jump to entry `index` of navHistory.view().entries. The caller owns the actual
  // navigation (dirty-gate, chapter change, focusing the row).
  onGo: (index: number) => void;
}

export function BackButton({ onGo }: Props) {
  const { entries, here } = useSyncExternalStore(navHistory.subscribe, navHistory.view);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const holdTimer = useRef<number | undefined>(undefined);
  const heldOpen = useRef(false);

  const newest = entries[here - 1];
  const ahead = entries.length - here;
  // Back is only dead when nothing lies behind the marker; the group is still
  // live when there is something ahead, so forward and the list stay usable.
  const empty = here === 0;
  const openMenu = () => {
    if (groupRef.current && entries.length > 0) setMenuAnchor(groupRef.current);
  };

  return (
    <>
      <Tooltip
        title={
          newest
            ? `Back to ${describeSpot(newest)} (hold for the list)`
            : ahead > 0
              ? "Nothing further back (hold for the list)"
              : "Back: nothing to go back to yet"
        }
      >
        <span>
          <ButtonGroup
            ref={groupRef}
            size="small"
            variant="outlined"
            disabled={entries.length === 0}
            aria-label="back"
            onContextMenu={(e) => {
              e.preventDefault();
              openMenu();
            }}
          >
            <Button
              disabled={empty}
              startIcon={<ArrowBackIcon fontSize="small" />}
              onPointerDown={() => {
                heldOpen.current = false;
                window.clearTimeout(holdTimer.current);
                holdTimer.current = window.setTimeout(() => {
                  heldOpen.current = true;
                  openMenu();
                }, HOLD_MS);
              }}
              onPointerUp={() => window.clearTimeout(holdTimer.current)}
              onPointerLeave={() => window.clearTimeout(holdTimer.current)}
              onClick={() => {
                // The press that opened the menu must not also jump.
                if (heldOpen.current) {
                  heldOpen.current = false;
                  return;
                }
                if (!empty) onGo(here - 1);
              }}
              sx={{ textTransform: "none", whiteSpace: "nowrap" }}
            >
              Back
            </Button>
            {ahead > 0 && (
              <Button
                size="small"
                aria-label="forward"
                onClick={() => onGo(here)}
                sx={{ px: 0.25, minWidth: 0 }}
              >
                <ArrowForwardIcon fontSize="small" />
              </Button>
            )}
            <Button
              size="small"
              aria-label="show where you have been"
              onClick={openMenu}
              sx={{ px: 0.25, minWidth: 0 }}
            >
              <ArrowDropDownIcon fontSize="small" />
            </Button>
          </ButtonGroup>
        </span>
      </Tooltip>
      <Menu
        open={menuAnchor !== null}
        anchorEl={menuAnchor}
        onClose={() => {
          heldOpen.current = false;
          setMenuAnchor(null);
        }}
        slotProps={{ paper: { sx: { maxHeight: 360 } } }}
      >
        {/* Newest first, with the "you are here" line where the person is:
            places ahead of it above, places behind it below. The current
            verse is not repeated; the line stands for it. */}
        {(() => {
          const row = (index: number) => {
            const spot = entries[index];
            return (
              <MenuItem
                key={`${index}:${spot.book}:${spot.chapter}:${spot.verse}:${spot.rowId ?? ""}`}
                onClick={() => {
                  heldOpen.current = false;
                  setMenuAnchor(null);
                  onGo(index);
                }}
              >
                <ListItemText
                  primary={describeSpot(spot)}
                  secondary={spot.hint}
                  secondaryTypographyProps={{ noWrap: true, sx: { maxWidth: 280 } }}
                />
              </MenuItem>
            );
          };
          const ahead: number[] = [];
          for (let i = entries.length - 1; i >= here; i--) ahead.push(i);
          const behind: number[] = [];
          for (let i = here - 1; i >= 0; i--) behind.push(i);
          return [
            ...ahead.map(row),
            <MenuItem key="here" disabled sx={{ opacity: "1 !important", py: 0.25, minHeight: 0 }}>
              <Divider sx={{ flex: 1, fontSize: 12, color: "text.secondary" }}>you are here</Divider>
            </MenuItem>,
            ...behind.map(row),
          ];
        })()}
      </Menu>
    </>
  );
}
