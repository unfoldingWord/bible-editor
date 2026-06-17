// Top-bar build stamp + "you're running stale code" nudge. Idle, it's a quiet
// `v <sha>` chip so anyone can confirm at a glance which build a translator is
// on ("are you on the latest prod?"). Once a newer build is deployed, the open
// tab notices (see useAppVersion) and the chip becomes a clickable
// "Update available — refresh" in the Kindle warning accent — so people don't
// have to compare numbers, the app tells them to reload.

import { Chip, Stack, Tooltip, Typography } from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import { useAppVersion } from "../hooks/useAppVersion";

// Kindle warning accent (#E59D33 from CLAUDE.md brand palette), matching the
// transient-state chips in SyncStatusBar.
const updateAccentSx = {
  color: "#E59D33",
  borderColor: "#E59D33",
  "& .MuiChip-icon": { color: "#E59D33" },
} as const;

function formatBuiltAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function VersionIndicator() {
  const { current, updateAvailable } = useAppVersion();

  if (updateAvailable) {
    return (
      <Tooltip title="A newer version is deployed. Click to reload and get the latest fixes.">
        <Chip
          icon={<RefreshIcon />}
          label="Update available — refresh"
          size="small"
          variant="outlined"
          clickable
          onClick={() => window.location.reload()}
          sx={updateAccentSx}
        />
      </Tooltip>
    );
  }

  // Don't show a meaningless "vunknown" stamp (e.g. a build without git info).
  if (current.commit === "unknown") return null;

  const tooltip = (
    <Stack spacing={0.25}>
      <Typography variant="caption" sx={{ fontFamily: "monospace" }}>
        build {current.commit}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {formatBuiltAt(current.builtAt)}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        You're on the latest version you've loaded.
      </Typography>
    </Stack>
  );

  return (
    <Tooltip title={tooltip}>
      <Chip
        label={`v ${current.commit}`}
        size="small"
        variant="outlined"
        sx={{
          fontFamily: "monospace",
          opacity: 0.6,
          "&:hover": { opacity: 1 },
        }}
      />
    </Tooltip>
  );
}
