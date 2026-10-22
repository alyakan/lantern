/**
 * Daylight: cool paper, dark ink, and a highlighter yellow that means one thing, "this needs you". Headings are set in
 * Bricolage Grotesque (loaded at the app's start; the system font stands in until it is); everything else is the
 * system font, so the phone reads like the phone.
 *
 * The phone's appearance picks the palette: Daylight, or Night (the same names turned over: ink is light, paper is
 * near-black). Components read theirs with `useColors()`.
 */
import { Platform, useColorScheme, type TextStyle } from "react-native";

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
  rule: string;
  /** The highlighter: only ever for what waits on the user. */
  hi: string;
  /** A soft wash of the highlighter, with `ink` words on it. */
  hiSoft: string;
  cobalt: string;
  go: string;
  stop: string;
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
  rule: "#dce2e8",
  hi: "#ffc21a",
  hiSoft: "#fff3cc",
  cobalt: "#2f5bff",
  go: "#1f9d55",
  stop: "#d93b3b",
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
  rule: "#27313c",
  hi: "#ffc21a",
  hiSoft: "#3b3010",
  cobalt: "#7b97ff",
  go: "#34b56c",
  stop: "#ff7272",
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

/** The palette for an appearance (Daylight unless it says dark). */
export const paletteFor = (scheme: "light" | "dark" | null | undefined): Palette => (scheme === "dark" ? darkColors : lightColors);

/** The colours of the phone's appearance now; the component draws again when it changes. */
export function useColors(): Palette {
  return paletteFor(useColorScheme());
}

export const fonts = {
  display: "BricolageGrotesque_700Bold",
  displayBold: "BricolageGrotesque_800ExtraBold",
  mono: Platform.select({ ios: "Menlo", default: "monospace" }) as string,
};

/** The names of the font files to load, as expo-font takes them. */
export const FONT_FILES = ["BricolageGrotesque_700Bold", "BricolageGrotesque_800ExtraBold"] as const;

export const radius = { card: 24, inner: 14, pill: 999, sheet: 22 } as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 28 } as const;

export type Variant = "headline" | "title" | "heading" | "body" | "small" | "tiny" | "mono";

/** The type scale: sizes and line heights, display type for headings. */
export const type: Record<Variant, TextStyle> = {
  headline: { fontFamily: fonts.displayBold, fontSize: 40, lineHeight: 42, letterSpacing: -1.2 },
  title: { fontFamily: fonts.display, fontSize: 28, lineHeight: 31, letterSpacing: -0.8 },
  heading: { fontFamily: fonts.display, fontSize: 19, lineHeight: 23, letterSpacing: -0.3 },
  body: { fontSize: 15, lineHeight: 21 },
  small: { fontSize: 13, lineHeight: 18 },
  tiny: { fontSize: 11, lineHeight: 14 },
  mono: { fontFamily: fonts.mono, fontSize: 13, lineHeight: 19 },
};

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

/** The smallest a touch target is (Apple's 44, Material's 48: the larger). */
export const MIN_TARGET = 48;
