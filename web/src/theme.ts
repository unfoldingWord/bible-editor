import { createTheme } from "@mui/material/styles";

// unfoldingWord brand palette
//   Inspire   #31ADE3  primary blue (accents, headings, CTAs)
//   Ocean     #014263  deep blue (headers, dark backgrounds)
//   Tech      #231F20  near-black body text
//   Cultivate #70C9CC  light teal secondary
//   Kindle    #E59D33  warm accent — sparingly
//
// Backgrounds are pushed to white across the board so the surrounding chrome
// (toolbars, section heads, active halos) reads cleanly against the page;
// active-state tints use a derived shade of Inspire rather than MUI's
// default light-grey.

export const theme = createTheme({
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
});
