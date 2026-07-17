import { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  IconButton,
  MenuItem,
  Snackbar,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import { useTranslation } from "react-i18next";
import { api, ApiError, type AdminUser } from "../sync/api";

// Bare allowlist error codes (api/src/adminUserRoutes.ts). Anything else
// (network failure, unexpected 5xx) falls back to the generic message —
// same "unknown code" fallback shape as laneErrorMessage in
// PreferencesWorkspace.tsx, just returning translated copy instead of the
// raw string since these codes aren't meant to be user-facing on their own.
function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, e: unknown): string {
  const code = e instanceof ApiError ? (e.body as { error?: string } | undefined)?.error : undefined;
  switch (code) {
    case "invalid_username":
      return t("preferences.users.errors.invalid_username");
    case "dcs_user_not_found":
      return t("preferences.users.errors.dcs_user_not_found");
    case "last_admin":
      return t("preferences.users.errors.last_admin");
    case "not_found":
      return t("preferences.users.errors.not_found");
    default:
      return t("preferences.actionFailed");
  }
}

// Admin-only editor/admin allowlist (user_roles table). Read-only viewers are
// NOT managed here — they come automatically from Door43 org membership; see
// the intro copy below for the plain-English version of that + the ~1h
// freshness caveat (role changes apply on the affected user's next JWT
// refresh, per auth.ts's ACCESS_COOKIE_TTL_SECONDS).
export function UserManagementSection() {
  const { t } = useTranslation();
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [newUsername, setNewUsername] = useState("");
  const [newRole, setNewRole] = useState<"admin" | "editor">("editor");
  const [adding, setAdding] = useState(false);
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const { users } = await api.adminListUsers();
      setUsers(users);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleAdd = async () => {
    const username = newUsername.trim();
    if (!username) return;
    setAdding(true);
    let ok = false;
    try {
      const res = await api.adminSetUserRole(username, newRole);
      ok = true;
      if (!res.dcsVerified) setMsg(t("preferences.users.unverified"));
    } catch (e) {
      setMsg(errorMessage(t, e));
    } finally {
      setAdding(false);
    }
    // Refetch regardless of outcome — on success this reflects the new row;
    // on failure it re-syncs the UI to true server state rather than trusting
    // an optimistic update that may be stale.
    await load();
    if (ok) {
      setNewUsername("");
      setNewRole("editor");
    }
  };

  const handleRoleChange = async (username: string, role: "admin" | "editor") => {
    setRowBusy(username);
    try {
      const res = await api.adminSetUserRole(username, role);
      if (!res.dcsVerified) setMsg(t("preferences.users.unverified"));
    } catch (e) {
      setMsg(errorMessage(t, e));
    } finally {
      setRowBusy(null);
    }
    await load();
  };

  const handleRemove = async (username: string) => {
    if (!window.confirm(t("preferences.users.confirmRemove", { username }))) return;
    setRowBusy(username);
    try {
      await api.adminRemoveUser(username);
    } catch (e) {
      setMsg(errorMessage(t, e));
    } finally {
      setRowBusy(null);
    }
    await load();
  };

  return (
    <Box component="section" aria-labelledby="user-management-heading">
      <Typography id="user-management-heading" variant="h6" gutterBottom>
        {t("preferences.users.title")}
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {t("preferences.users.intro")}
      </Typography>

      <Box sx={{ border: "1px dashed", borderColor: "divider", borderRadius: 1, p: 1.5, mb: 2 }}>
        <Stack direction="row" spacing={1} flexWrap="wrap" gap={1} alignItems="flex-start">
          <TextField
            size="small"
            label={t("preferences.users.username")}
            value={newUsername}
            onChange={(e) => setNewUsername(e.target.value)}
            sx={{ width: 220 }}
          />
          <TextField
            select
            size="small"
            label={t("preferences.users.role")}
            value={newRole}
            onChange={(e) => setNewRole(e.target.value as "admin" | "editor")}
            sx={{ width: 160 }}
          >
            <MenuItem value="editor">{t("preferences.users.roleEditor")}</MenuItem>
            <MenuItem value="admin">{t("preferences.users.roleAdmin")}</MenuItem>
          </TextField>
          <Button
            variant="contained"
            startIcon={adding ? <CircularProgress size={16} color="inherit" /> : <AddIcon />}
            onClick={handleAdd}
            disabled={adding || !newUsername.trim()}
          >
            {t("preferences.users.add")}
          </Button>
        </Stack>
      </Box>

      {users === null ? (
        loadError ? (
          <Alert
            severity="error"
            action={
              <Button size="small" onClick={() => void load()}>
                {t("preferences.users.retry")}
              </Button>
            }
          >
            {t("preferences.users.loadFailed")}
          </Alert>
        ) : (
          <CircularProgress size={22} />
        )
      ) : (
        <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 1, overflow: "hidden" }}>
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: "1fr 140px 160px 160px 40px",
              gap: 1,
              px: 1.5,
              py: 0.75,
              bgcolor: "grey.50",
              fontFamily: "monospace",
              fontSize: 10,
              textTransform: "uppercase",
              color: "text.disabled",
              borderBottom: "1px dashed",
              borderColor: "divider",
            }}
          >
            <span>{t("preferences.users.username")}</span>
            <span>{t("preferences.users.role")}</span>
            <span>{t("preferences.users.added")}</span>
            <span>{t("preferences.users.addedBy")}</span>
            <span />
          </Box>
          {users.map((u) => (
            <Box
              key={u.username}
              sx={{
                display: "grid",
                gridTemplateColumns: "1fr 140px 160px 160px 40px",
                gap: 1,
                px: 1.5,
                py: 0.75,
                alignItems: "center",
                borderBottom: "1px dashed",
                borderColor: "divider",
                "&:last-of-type": { borderBottom: "none" },
              }}
            >
              <Typography variant="body2" sx={{ overflow: "hidden", textOverflow: "ellipsis" }}>
                {u.username}
              </Typography>
              <TextField
                select
                size="small"
                value={u.role}
                onChange={(e) => void handleRoleChange(u.username, e.target.value as "admin" | "editor")}
                disabled={rowBusy === u.username}
              >
                <MenuItem value="editor">{t("preferences.users.roleEditor")}</MenuItem>
                <MenuItem value="admin">{t("preferences.users.roleAdmin")}</MenuItem>
              </TextField>
              <Typography variant="body2" color="text.secondary">
                {u.addedAt != null ? new Date(u.addedAt * 1000).toLocaleDateString() : "—"}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {u.addedBy ?? "—"}
              </Typography>
              <Tooltip title={t("preferences.users.remove")}>
                <span>
                  <IconButton
                    size="small"
                    color="error"
                    onClick={() => void handleRemove(u.username)}
                    disabled={rowBusy === u.username}
                  >
                    <DeleteOutlineIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            </Box>
          ))}
        </Box>
      )}

      <Snackbar open={!!msg} autoHideDuration={4000} onClose={() => setMsg(null)} message={msg ?? ""} />
    </Box>
  );
}
