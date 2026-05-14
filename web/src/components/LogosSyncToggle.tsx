import { useEffect, useState } from "react";
import { Checkbox, FormControlLabel, Tooltip } from "@mui/material";

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

const STORAGE_KEY = "be:logosSyncEnabled";

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

  // Fire a logosref: URI when the active reference changes. Debounced so
  // rapid verse scrubbing doesn't flood the protocol handler. Custom-scheme
  // navigation hands off to the OS — the page itself does not navigate.
  useEffect(() => {
    if (!enabled || verse <= 0 || chapter <= 0) return;
    const timer = window.setTimeout(() => {
      const abbr = toLogosAbbr(book);
      window.location.href = `logosref:Bible.${abbr}${chapter}.${verse}`;
    }, 400);
    return () => window.clearTimeout(timer);
  }, [enabled, book, chapter, verse]);

  return (
    <Tooltip title="When enabled, Logos Bible Software follows the active verse.">
      <FormControlLabel
        control={
          <Checkbox
            size="small"
            checked={enabled}
            onChange={(e) => {
              const v = e.target.checked;
              setEnabled(v);
              try {
                localStorage.setItem(STORAGE_KEY, String(v));
              } catch {
                /* ignore */
              }
            }}
          />
        }
        label="Logos sync"
        sx={{
          mr: 0,
          "& .MuiFormControlLabel-label": { fontSize: 13 },
        }}
      />
    </Tooltip>
  );
}
