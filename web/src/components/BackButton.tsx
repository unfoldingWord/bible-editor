// Always-visible "Back" control for the top bar. One click returns to the
// newest remembered spot (verse, and the note/question/word link if one was
// focused); press-and-hold, right-click, or the small arrow opens the list of
// everywhere the person has been so they can pick an older one. See
// lib/navHistory.ts for what counts as a remembered spot.

import { useRef, useState, useSyncExternalStore } from "react";
import Button from "@mui/material/Button";
import ButtonGroup from "@mui/material/ButtonGroup";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import ListItemText from "@mui/material/ListItemText";
import Tooltip from "@mui/material/Tooltip";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import { bookName } from "../lib/bookNames";
import { navHistory, type NavSpot } from "../lib/navHistory";

const HOLD_MS = 450;

const KIND_LABEL = { tn: "note", tq: "question", twl: "word link" } as const;

export function describeSpot(s: NavSpot): string {
  const place = `${bookName(s.book)} ${s.chapter === 0 ? "intro" : `${s.chapter}:${s.verse}`}`;
  return s.kind ? `${place} · ${KIND_LABEL[s.kind]}` : place;
}

interface Props {
  // Jump to entry `index` of navHistory.entries(). The caller owns the actual
  // navigation (dirty-gate, chapter change, focusing the row).
  onGo: (index: number) => void;
}

export function BackButton({ onGo }: Props) {
  const entries = useSyncExternalStore(navHistory.subscribe, navHistory.entries);
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const holdTimer = useRef<number | undefined>(undefined);
  const heldOpen = useRef(false);

  const newest = entries[entries.length - 1];
  const empty = entries.length === 0;
  const openMenu = () => {
    if (groupRef.current && entries.length > 0) setMenuAnchor(groupRef.current);
  };

  return (
    <>
      <Tooltip
        title={
          newest
            ? `Back to ${describeSpot(newest)} (hold for the list)`
            : "Back: nothing to go back to yet"
        }
      >
        <span>
          <ButtonGroup
            ref={groupRef}
            size="small"
            variant="outlined"
            disabled={empty}
            aria-label="back"
            onContextMenu={(e) => {
              e.preventDefault();
              openMenu();
            }}
          >
            <Button
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
                if (!empty) onGo(entries.length - 1);
              }}
              sx={{ textTransform: "none", whiteSpace: "nowrap" }}
            >
              Back
            </Button>
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
        onClose={() => setMenuAnchor(null)}
        slotProps={{ paper: { sx: { maxHeight: 360 } } }}
      >
        {/* Newest first: the top row is what plain Back does. */}
        {entries
          .map((spot, index) => ({ spot, index }))
          .reverse()
          .map(({ spot, index }) => (
            <MenuItem
              key={`${index}:${spot.book}:${spot.chapter}:${spot.verse}:${spot.rowId ?? ""}`}
              onClick={() => {
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
          ))}
      </Menu>
    </>
  );
}
