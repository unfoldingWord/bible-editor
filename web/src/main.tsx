import React, { useCallback, useEffect, useMemo, useState } from "react";
import ReactDOM from "react-dom/client";
import { ThemeProvider, CssBaseline } from "@mui/material";
import { makeTheme, ThemeModeContext, type ThemeMode } from "./theme";
import { App } from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { installCurlyQuotes } from "./lib/curlyQuotes";

installCurlyQuotes();

const THEME_MODE_KEY = "be:themeMode";

function loadInitialMode(): ThemeMode {
  try {
    const raw = localStorage.getItem(THEME_MODE_KEY);
    if (raw === "light" || raw === "dark") return raw;
  } catch {
    /* ignore */
  }
  if (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}

function Root() {
  const [mode, setMode] = useState<ThemeMode>(loadInitialMode);

  useEffect(() => {
    try {
      localStorage.setItem(THEME_MODE_KEY, mode);
    } catch {
      /* ignore */
    }
  }, [mode]);

  const toggle = useCallback(() => {
    setMode((m) => (m === "dark" ? "light" : "dark"));
  }, []);

  const theme = useMemo(() => makeTheme(mode), [mode]);
  const ctx = useMemo(() => ({ mode, toggle }), [mode, toggle]);

  return (
    <ThemeModeContext.Provider value={ctx}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <AppErrorBoundary>
          <App />
        </AppErrorBoundary>
      </ThemeProvider>
    </ThemeModeContext.Provider>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("root element missing");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
