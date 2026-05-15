import { createContext } from "react";
import { createTheme, type Theme, type ThemeOptions } from "@mui/material/styles";

// Scrollbar overrides apply globally via CssBaseline. We pick a thumb that
// contrasts with the page background but stays subtle. Firefox uses the
// standard `scrollbar-color` shorthand; Chromium/Safari need the webkit
// pseudo-elements.
function scrollbarComponents(track: string, thumb: string, thumbHover: string): ThemeOptions["components"] {
  return {
    MuiCssBaseline: {
      styleOverrides: {
        "*": {
          scrollbarColor: `${thumb} ${track}`,
          scrollbarWidth: "thin",
        },
        "*::-webkit-scrollbar": {
          width: 12,
          height: 12,
        },
        "*::-webkit-scrollbar-track": {
          backgroundColor: track,
        },
        "*::-webkit-scrollbar-thumb": {
          backgroundColor: thumb,
          borderRadius: 8,
          border: `3px solid ${track}`,
        },
        "*::-webkit-scrollbar-thumb:hover": {
          backgroundColor: thumbHover,
        },
        "*::-webkit-scrollbar-corner": {
          backgroundColor: track,
        },
      },
    },
  };
}

// unfoldingWord brand palette
//   Inspire   #31ADE3  primary blue (accents, headings, CTAs)
//   Ocean     #014263  deep blue (headers, dark backgrounds)
//   Tech      #231F20  near-black body text
//   Cultivate #70C9CC  light teal secondary
//   Kindle    #E59D33  warm accent — sparingly
//
// Light mode pushes backgrounds to white so the surrounding chrome
// (toolbars, section heads, active halos) reads cleanly. Dark mode anchors
// on Tech (#231F20) for surfaces and lifts text toward white; Inspire stays
// the primary accent in both modes.

export type ThemeMode = "light" | "dark";

const lightTheme = createTheme({
  palette: {
    mode: "light",
    primary: {
      main: "#31ADE3",
      light: "#66BCE7",
      dark: "#014263",
      contrastText: "#FFFFFF",
      "50": "#E6F4FB",
      "100": "#CCE9F7",
      "200": "#99D3EF",
      "300": "#66BCE7",
      "400": "#33A6DF",
      "500": "#31ADE3",
      "600": "#0089BB",
      "700": "#016693",
      "800": "#01446B",
      "900": "#014263",
    },
    secondary: {
      main: "#70C9CC",
      light: "#A0DEDF",
      dark: "#3F9CA0",
      contrastText: "#231F20",
    },
    warning: {
      main: "#E59D33",
      light: "#F2B967",
      dark: "#B57215",
      contrastText: "#231F20",
    },
    info: { main: "#31ADE3" },
    success: { main: "#70C9CC", contrastText: "#231F20" },
    background: {
      default: "#FFFFFF",
      paper: "#FFFFFF",
    },
    text: {
      primary: "#231F20",
      secondary: "#5C6A78",
      disabled: "#9AA5B0",
    },
    divider: "#E5EBF0",
    grey: {
      "50": "#FFFFFF",
      "100": "#F4F8FB",
      "200": "#E8EFF5",
      "300": "#D6DEE5",
      "400": "#9AA5B0",
      "500": "#5C6A78",
      "600": "#3F4956",
      "700": "#2C333D",
      "800": "#1F242C",
      "900": "#15191F",
      A100: "#F4F8FB",
      A200: "#E8EFF5",
      A400: "#9AA5B0",
      A700: "#2C333D",
    },
  },
  shape: { borderRadius: 6 },
  typography: {
    fontFamily:
      '"Roboto","Helvetica","Arial",sans-serif,"Apple Color Emoji","Segoe UI Emoji"',
  },
  components: scrollbarComponents("#F4F8FB", "#C2CCD6", "#9AA5B0"),
});

const darkTheme = createTheme({
  palette: {
    mode: "dark",
    primary: {
      main: "#66BCE7",
      light: "#99D3EF",
      dark: "#31ADE3",
      contrastText: "#0A1620",
      "50": "#01446B",
      "100": "#016693",
      "200": "#0089BB",
      "300": "#31ADE3",
      "400": "#33A6DF",
      "500": "#66BCE7",
      "600": "#99D3EF",
      "700": "#CCE9F7",
      "800": "#E6F4FB",
      "900": "#F4FAFD",
    },
    secondary: {
      main: "#70C9CC",
      light: "#A0DEDF",
      dark: "#3F9CA0",
      contrastText: "#0A1620",
    },
    warning: {
      main: "#E59D33",
      light: "#F2B967",
      dark: "#B57215",
      contrastText: "#0A1620",
    },
    info: { main: "#66BCE7" },
    success: { main: "#70C9CC", contrastText: "#0A1620" },
    background: {
      default: "#15191F",
      paper: "#1F242C",
    },
    text: {
      primary: "#F4F8FB",
      secondary: "#9AA5B0",
      disabled: "#5C6A78",
    },
    divider: "#2C333D",
    grey: {
      "50": "#15191F",
      "100": "#1F242C",
      "200": "#2C333D",
      "300": "#3F4956",
      "400": "#5C6A78",
      "500": "#9AA5B0",
      "600": "#D6DEE5",
      "700": "#E8EFF5",
      "800": "#F4F8FB",
      "900": "#FFFFFF",
      A100: "#1F242C",
      A200: "#2C333D",
      A400: "#9AA5B0",
      A700: "#E8EFF5",
    },
  },
  shape: { borderRadius: 6 },
  typography: {
    fontFamily:
      '"Roboto","Helvetica","Arial",sans-serif,"Apple Color Emoji","Segoe UI Emoji"',
  },
  components: scrollbarComponents("#1F242C", "#3F4956", "#5C6A78"),
});

export function makeTheme(mode: ThemeMode): Theme {
  return mode === "dark" ? darkTheme : lightTheme;
}

// Kept for back-compat with any existing import sites.
export const theme = lightTheme;

export interface ThemeModeContextValue {
  mode: ThemeMode;
  toggle: () => void;
}

export const ThemeModeContext = createContext<ThemeModeContextValue>({
  mode: "light",
  toggle: () => {},
});
