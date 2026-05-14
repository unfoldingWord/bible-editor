import { useEffect, useState } from "react";
import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  FormControlLabel,
  IconButton,
  Stack,
  Tooltip,
} from "@mui/material";
import SyncIcon from "@mui/icons-material/Sync";

// USFM 3-letter code (lowercase) → Logos Bible abbreviation.
// Matches the table from the upstream Logos-sync bookmarklet.
const LOGOS_MAP: Record<string, string> = {
  gen: "Ge", exo: "Ex", lev: "Le", num: "Nu", deu: "Dt",
  jos: "Jos", jdg: "Jdg", rut: "Ru",
  "1sa": "1Sa", "2sa": "2Sa", "1ki": "1Ki", "2ki": "2Ki",
  "1ch": "1Ch", "2ch": "2Ch",
  ezr: "Ezr", neh: "Ne", est: "Es",
  job: "Job", psa: "Ps", pro: "Pr", ecc: "Ec", sng: "So",
  isa: "Is", jer: "Je", lam: "La", ezk: "Eze", dan: "Da",
  hos: "Ho", jol: "Joe", amo: "Am", oba: "Ob", jon: "Jon",
  mic: "Mic", nam: "Na", hab: "Hab", zep: "Zep", hag: "Hag",
  zec: "Zec", mal: "Mal",
  mat: "Mt", mrk: "Mk", luk: "Lk", jhn: "Jn", act: "Ac",
  rom: "Ro", "1co": "1Co", "2co": "2Co", gal: "Ga", eph: "Eph",
  php: "Php", col: "Col", "1th": "1Th", "2th": "2Th",
  "1ti": "1Ti", "2ti": "2Ti", tit: "Ti", phm: "Phm",
  heb: "Heb", jas: "Jas", "1pe": "1Pe", "2pe": "2Pe",
  "1jn": "1Jn", "2jn": "2Jn", "3jn": "3Jn", jud: "Jude", rev: "Re",
};

function toLogosAbbr(book: string): string {
  const key = book.toLowerCase();
  return LOGOS_MAP[key] ?? key.charAt(0).toUpperCase() + key.slice(1);
}

function fireLogos(book: string, chapter: number, verse: number) {
  if (chapter <= 0 || verse <= 0) return;
  const abbr = toLogosAbbr(book);
  window.location.href = `logosref:Bible.${abbr}${chapter}.${verse}`;
}

const STORAGE_KEY = "be:logosSyncEnabled";
const WARNING_HIDDEN_KEY = "be:logosSyncWarningHidden";

interface Props {
  book: string;
  chapter: number;
  verse: number;
}

export function LogosSyncToggle({ book, chapter, verse }: Props) {
  const [enabled, setEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });
  const [warnOpen, setWarnOpen] = useState(false);
  const [dontShowAgain, setDontShowAgain] = useState(false);

  // Debounced auto-follow when enabled. Custom-scheme navigation hands off
  // to the OS — the page itself does not navigate. Note: Logos has no
  // no-focus mode, so each fire raises its window.
  useEffect(() => {
    if (!enabled) return;
    const timer = window.setTimeout(() => fireLogos(book, chapter, verse), 400);
    return () => window.clearTimeout(timer);
  }, [enabled, book, chapter, verse]);

  const persistEnabled = (v: boolean) => {
    setEnabled(v);
    try {
      localStorage.setItem(STORAGE_KEY, String(v));
    } catch {
      /* ignore */
    }
  };

  const handleCheckboxChange = (next: boolean) => {
    if (!next) {
      persistEnabled(false);
      return;
    }
    let hidden = false;
    try {
      hidden = localStorage.getItem(WARNING_HIDDEN_KEY) === "true";
    } catch {
      /* ignore */
    }
    if (hidden) {
      persistEnabled(true);
      return;
    }
    setDontShowAgain(false);
    setWarnOpen(true);
  };

  const handleConfirm = () => {
    if (dontShowAgain) {
      try {
        localStorage.setItem(WARNING_HIDDEN_KEY, "true");
      } catch {
        /* ignore */
      }
    }
    persistEnabled(true);
    setWarnOpen(false);
  };

  return (
    <Stack direction="row" alignItems="center" spacing={0.5}>
      <Tooltip title="Send the active verse to Logos now">
        <IconButton size="small" onClick={() => fireLogos(book, chapter, verse)}>
          <SyncIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Tooltip title="Auto-follow active verse in Logos (steals focus on each change)">
        <FormControlLabel
          control={
            <Checkbox
              size="small"
              checked={enabled || warnOpen}
              onChange={(e) => handleCheckboxChange(e.target.checked)}
            />
          }
          label="Logos sync"
          sx={{
            mr: 0,
            "& .MuiFormControlLabel-label": { fontSize: 13 },
          }}
        />
      </Tooltip>
      <Dialog open={warnOpen} onClose={() => setWarnOpen(false)}>
        <DialogTitle>Enable Logos sync?</DialogTitle>
        <DialogContent>
          <DialogContentText>
            Checking this will cause Logos to steal focus (bring its window to
            the front) every time you change verses. Fine if you have Logos on
            a second monitor, but otherwise just use the sync button when you
            want to move Logos.
          </DialogContentText>
          <FormControlLabel
            sx={{ mt: 2 }}
            control={
              <Checkbox
                checked={dontShowAgain}
                onChange={(e) => setDontShowAgain(e.target.checked)}
              />
            }
            label="Don't show this again"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setWarnOpen(false)}>Cancel</Button>
          <Button onClick={handleConfirm} variant="contained">
            OK
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  );
}
