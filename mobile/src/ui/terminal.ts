/**
 * The terminal's colours: dark in both appearances, as a terminal is on the Mac. They are the same everywhere a terminal is
 * drawn (the message box turned terminal, and the card a command's output fills).
 */
export const term = {
  bg: "#0d1117",
  field: "#161b22",
  line: "#2a313c",
  text: "#c9d1d9",
  out: "#a6b0bb",
  dim: "#7d8590",
  hi: "#e6edf3",
  bright: "#3fb950",
  fail: "#f85149",
} as const;
