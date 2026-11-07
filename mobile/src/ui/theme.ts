/**
 * Daylight: cool paper, dark ink, and a highlighter yellow that means one thing, "this needs you". Headings are set in
 * Bricolage Grotesque (loaded at the app's start; the system font stands in until it is); everything else is the
 * system font, so the phone reads like the phone.
 *
 * The phone's appearance picks the palette: Daylight, or Night (the same names turned over: ink is light, paper is
 * near-black). Or its owner picks a theme (Settings > This phone > Theme): the Mac's Gruvbox Dark, Catppuccin Mocha, Tokyo Night,
 * Rosé Pine or Catppuccin Latte, in the same fields. Components read theirs with `useColors()`.
 */
import { useSyncExternalStore } from "react";
import { Appearance, Platform, useColorScheme, useWindowDimensions, type TextStyle } from "react-native";
import { layoutFor } from "../view/layout";

export interface Palette {
  /** Which of the two this is. */
  isDark: boolean;
  /** The page. */
  paper: string;
  /** What sits on the page: cards, sheets. */
  card: string;
  /** Text, and what is filled with it (a selected pill, the main button). */
  ink: string;
  ink2: string;
  ink3: string;
  /** What is written on something filled with `ink`: the other way round. */
  onInk: string;
  /** What is written on the highlighter: dark in both. */
  onHi: string;
  /** What is written on a `go` fill (the green button, the swipe's done): white, except on a theme whose green is pale. */
  onGo: string;
  rule: string;
  /** The highlighter: only ever for what waits on the user. */
  hi: string;
  /** A soft wash of the highlighter, with `ink` words on it. */
  hiSoft: string;
  cobalt: string;
  go: string;
  stop: string;
  /** Claude's orange (the desktop's): something a chat runs in the background. */
  working: string;
  /** Always white: on the full-screen decision's night, and on go, stop and Ember fills. */
  white: string;
  /** The full-screen decision's own dark. */
  night: string;
  nightText: string;
  nightRaised: string;
  /** Red that reads on the night background. */
  nightStop: string;
  /** The shapes of a skeleton, and the stronger ones: they have to stand out from the page and from a card at their dimmest. */
  shape: string;
  shapeStrong: string;
  /** A hairline on the night background. */
  nightLine: string;
  /** What dims the screen behind a sheet. */
  scrim: string;
  /** The tag of a project the Mac gave no colour. */
  plainTint: { bg: string; fg: string };
  /** A faint wash behind code in `ink` text. */
  wash: string;
}

export const lightColors: Palette = {
  isDark: false,
  paper: "#eef1f4",
  card: "#ffffff",
  ink: "#15212e",
  ink2: "#566272",
  ink3: "#8a94a1",
  onInk: "#ffffff",
  onHi: "#15212e",
  onGo: "#ffffff",
  rule: "#dce2e8",
  hi: "#ffc21a",
  hiSoft: "#fff3cc",
  cobalt: "#2f5bff",
  go: "#1f9d55",
  stop: "#d93b3b",
  working: "#d4693f",
  white: "#ffffff",
  night: "#15212e",
  nightText: "#b8c2cf",
  nightRaised: "rgba(255,255,255,0.08)",
  nightStop: "#ff8b8b",
  shape: "#cdd5de",
  shapeStrong: "#aeb9c6",
  nightLine: "rgba(255,255,255,0.14)",
  scrim: "#00000066",
  plainTint: { bg: "#dce2e8", fg: "#566272" },
  wash: "#0000000d",
};

/** Night: the page near-black with a cool cast, cards a step lighter (a shadow doesn't show on it, a lighter card does). */
export const darkColors: Palette = {
  isDark: true,
  paper: "#0b1016",
  card: "#161e27",
  ink: "#e9eef3",
  ink2: "#a7b2bf",
  ink3: "#76828f",
  onInk: "#0b1016",
  onHi: "#15212e",
  onGo: "#ffffff",
  rule: "#27313c",
  hi: "#ffc21a",
  hiSoft: "#3b3010",
  cobalt: "#7b97ff",
  go: "#34b56c",
  stop: "#ff7272",
  working: "#ef8a5c",
  white: "#ffffff",
  night: "#15212e",
  nightText: "#b8c2cf",
  nightRaised: "rgba(255,255,255,0.08)",
  nightStop: "#ff8b8b",
  shape: "#26313d",
  shapeStrong: "#34414f",
  nightLine: "rgba(255,255,255,0.14)",
  scrim: "#000000aa",
  plainTint: { bg: "#27313c", fg: "#a7b2bf" },
  wash: "#ffffff14",
};

/** `fg` laid over `bg` at `alpha` (0 to 1), as #rrggbb. */
function blend(fg: string, bg: string, alpha: number): string {
  const channel = (hex: string, i: number) => parseInt(hex.slice(i, i + 2), 16);
  return `#${[1, 3, 5].map((i) => Math.round(channel(fg, i) * alpha + channel(bg, i) * (1 - alpha)).toString(16).padStart(2, "0")).join("")}`;
}

/** What a theme says for itself; the rest (white, the lines on night, the scrim, the wash) is Daylight's or Night's. */
type Own = Pick<Palette, "paper" | "card" | "ink" | "ink2" | "ink3" | "onInk" | "onHi" | "onGo" | "rule" | "hi" | "cobalt" | "go" | "stop" | "working" | "night" | "nightText" | "nightStop" | "shape" | "shapeStrong">;

/** A theme's palette: its own colours over Daylight's or Night's, the highlighter's wash made from its own highlighter and page. */
function preset(isDark: boolean, own: Own): Palette {
  return { ...(isDark ? darkColors : lightColors), ...own, isDark, hiSoft: blend(own.hi, own.paper, isDark ? 0.15 : 0.3), plainTint: { bg: own.rule, fg: own.ink2 } };
}

// The Mac's themes, from their token blocks in src/styles.css: paper is --pane, card the surface a step off it, ink --text, the
// highlighter --attn, cobalt --unread, go and stop --add and --del. Mocha, Tokyo Night and Rosé Pine are one dark blue-violet
// family, and a phone is mostly words on a page, so they differ more here than on the Mac: their pages and cards lean further
// to their own hue (mauve-grey, navy, plum), and the highlighter and cobalt are each one's own accent (mauve, blue, rose)
// instead of the Mac's yellow and blues, so the accent shows wherever something needs you or can be pressed.
const GRUVBOX = preset(true, { paper: "#282828", card: "#3c3836", ink: "#ebdbb2", ink2: "#d5c4a1", ink3: "#b3a181", onInk: "#282828", onHi: "#282828", onGo: "#282828", rule: "#504945", hi: "#fabd2f", cobalt: "#8ec0d0", go: "#8ec07c", stop: "#ff8a93", working: "#fe8019", night: "#1d2021", nightText: "#d5c4a1", nightStop: "#ff8a93", shape: "#504945", shapeStrong: "#665c54" });
const MOCHA = preset(true, { paper: "#221e30", card: "#342e48", ink: "#cdd6f4", ink2: "#bac2de", ink3: "#9fa0bd", onInk: "#221e30", onHi: "#221e30", onGo: "#221e30", rule: "#4b4563", hi: "#cba6f7", cobalt: "#cba6f7", go: "#a6e3a1", stop: "#f38ba8", working: "#fab387", night: "#1a1726", nightText: "#bac2de", nightStop: "#f38ba8", shape: "#4b4563", shapeStrong: "#5e5879" });
const TOKYO = preset(true, { paper: "#16213a", card: "#20304f", ink: "#c0caf5", ink2: "#a9b1d6", ink3: "#8a96c0", onInk: "#16213a", onHi: "#0b1222", onGo: "#16213a", rule: "#34476b", hi: "#7aa2f7", cobalt: "#7aa2f7", go: "#9ece6a", stop: "#f7768e", working: "#ff9e64", night: "#101827", nightText: "#a9b1d6", nightStop: "#f7768e", shape: "#34476b", shapeStrong: "#4a5f88" });
const ROSE = preset(true, { paper: "#251a2a", card: "#382538", ink: "#efdfe6", ink2: "#d3c0cd", ink3: "#aa94a8", onInk: "#251a2a", onHi: "#251a2a", onGo: "#251a2a", rule: "#4f3b57", hi: "#ebbcba", cobalt: "#ebbcba", go: "#7fb69a", stop: "#eb6f92", working: "#f6c177", night: "#1c131f", nightText: "#d3c0cd", nightStop: "#eb6f92", shape: "#4f3b57", shapeStrong: "#664d70" });
const LATTE = preset(false, { paper: "#eff1f5", card: "#ffffff", ink: "#3f4259", ink2: "#545770", ink3: "#74778c", onInk: "#ffffff", onHi: "#1f2133", onGo: "#ffffff", rule: "#ccd0da", hi: "#f2b83a", cobalt: "#1452c4", go: "#1f6514", stop: "#b80c30", working: "#a34307", night: "#2c2f45", nightText: "#c3c8e0", nightStop: "#ff8b8b", shape: "#c9ceda", shapeStrong: "#a9afc0" });

/** What Settings offers: "system" follows the iPhone's appearance; the rest are fixed (their `scheme` is what iOS is told, so its own parts match). */
export type ThemeChoice = "system" | "light" | "dark" | "gruvbox" | "mocha" | "tokyo" | "rose" | "latte";

export const THEME_CHOICES: { id: ThemeChoice; label: string; scheme: "light" | "dark" | null; palette: Palette | null }[] = [
  { id: "system", label: "Follow system", scheme: null, palette: null },
  { id: "light", label: "Daylight", scheme: "light", palette: lightColors },
  { id: "dark", label: "Night", scheme: "dark", palette: darkColors },
  { id: "gruvbox", label: "Gruvbox Dark", scheme: "dark", palette: GRUVBOX },
  { id: "mocha", label: "Catppuccin Mocha", scheme: "dark", palette: MOCHA },
  { id: "tokyo", label: "Tokyo Night", scheme: "dark", palette: TOKYO },
  { id: "rose", label: "Rosé Pine", scheme: "dark", palette: ROSE },
  { id: "latte", label: "Catppuccin Latte", scheme: "light", palette: LATTE },
];

export const isThemeChoice = (v: unknown): v is ThemeChoice => THEME_CHOICES.some((t) => t.id === v);

/** The palette for an appearance (Daylight unless it says dark), or for the theme chosen, which has its own whatever the appearance. */
export const paletteFor = (scheme: "light" | "dark" | null | undefined, choice: ThemeChoice = "system"): Palette => THEME_CHOICES.find((t) => t.id === choice)?.palette ?? (scheme === "dark" ? darkColors : lightColors);

// The theme chosen, kept here (not in a screen) so every component draws in it, and a change reaches them all at once.
let chosen: ThemeChoice = "system";
const listeners = new Set<() => void>();

/** Makes a theme the phone's: its palette from the next draw, and iOS told its light or dark, so the keyboard, the status bar and the glass match. */
export function setThemeChoice(choice: ThemeChoice): void {
  chosen = choice;
  try {
    // "unspecified" hands it back to the system: what Follow iPhone is.
    Appearance.setColorScheme(THEME_CHOICES.find((t) => t.id === choice)?.scheme ?? "unspecified");
  } catch {
    // Not told (no native module): the palettes still follow the choice.
  }
  listeners.forEach((l) => l());
}

export const getThemeChoice = (): ThemeChoice => chosen;

/** The theme chosen now; the component draws again when it changes. */
export function useThemeChoice(): ThemeChoice {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => void listeners.delete(onChange);
    },
    getThemeChoice,
  );
}

/** The colours of the phone's theme now (or its appearance's, when it follows the iPhone); the component draws again when it changes. */
export function useColors(): Palette {
  return paletteFor(useColorScheme(), useThemeChoice());
}

export const fonts = {
  display: "BricolageGrotesque_700Bold",
  displayBold: "BricolageGrotesque_800ExtraBold",
  mono: Platform.select({ ios: "Menlo", default: "monospace" }) as string,
};

/** The names of the font files to load, as expo-font takes them. */
export const FONT_FILES = ["BricolageGrotesque_700Bold", "BricolageGrotesque_800ExtraBold"] as const;

/**
 * The height of the round buttons, the title bar and the chat bar that sit near one another in a chat (the back button, the title,
 * Stop, the search circle, the message box at rest): one number, so they line up. The message box's own field is `control - 12`
 * (6 points of capsule around it).
 */
export const control = 44;

/** The round buttons inside the chat bar (send, dictate, attach, Stop): a little inside its capsule. */
export const barButton = control - 8;

/** `block`: a card in a chat that holds words (a summary, a page, a prompt, a review): one size for all of them. */
export const radius = { card: 24, inner: 14, pill: 999, sheet: 22, block: 18 } as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 28 } as const;

export type Variant = "headline" | "title" | "heading" | "body" | "small" | "tiny" | "mono";

/** The type scale: sizes and line heights, display type for headings. */
export const type: Record<Variant, TextStyle> = {
  headline: { fontFamily: fonts.displayBold, fontSize: 40, lineHeight: 42, letterSpacing: -1.2 },
  title: { fontFamily: fonts.display, fontSize: 28, lineHeight: 31, letterSpacing: -0.8 },
  heading: { fontFamily: fonts.display, fontSize: 19, lineHeight: 23, letterSpacing: -0.3 },
  body: { fontSize: 17, lineHeight: 22 },
  small: { fontSize: 13, lineHeight: 18 },
  tiny: { fontSize: 11, lineHeight: 14 },
  mono: { fontFamily: fonts.mono, fontSize: 13, lineHeight: 19 },
};

/**
 * The body on a phone: Apple's 17 is set for a tablet held further away, and at a phone's arm's length 16 with its own line
 * height is the size that reads right. The rest of the scale is the same on both.
 */
export const phoneBody: TextStyle = { fontSize: 16, lineHeight: 21 };

/**
 * The body for the window the app is in: 16 on a phone, 17 on a tablet. The layout decides (the same call that gives the page its
 * margins), so an iPad in a narrow Split View pane, laid out as a phone, gets the phone's size, and a window wide enough to be a
 * tablet's never gets it for being short.
 */
export function useBody(): TextStyle {
  const { width, height } = useWindowDimensions();
  return layoutFor(width, height) === "phone" ? phoneBody : type.body;
}

// Black shadows: they read on Daylight's page and are simply not seen on Night's (its cards are lighter than its page instead).
export const shadow = {
  card: Platform.select({
    ios: { shadowColor: "#000", shadowOpacity: 0.16, shadowRadius: 18, shadowOffset: { width: 0, height: 10 } },
    default: { elevation: 6 },
  }) as object,
  float: Platform.select({
    ios: { shadowColor: "#000", shadowOpacity: 0.28, shadowRadius: 14, shadowOffset: { width: 0, height: 6 } },
    default: { elevation: 8 },
  }) as object,
};

/** The smallest a touch target is: Apple's 44 points. */
export const MIN_TARGET = 44;
