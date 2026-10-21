/**
 * Daylight: cool paper, dark ink, and a highlighter yellow that means one thing, "this needs you". Headings are set in
 * Bricolage Grotesque (loaded at the app's start; the system font stands in until it is); everything else is the
 * system font, so the phone reads like the phone.
 */
import { Platform, type TextStyle } from "react-native";

export const colors = {
  paper: "#eef1f4",
  card: "#ffffff",
  ink: "#15212e",
  ink2: "#566272",
  ink3: "#8a94a1",
  rule: "#dce2e8",
  /** The highlighter: only ever for what waits on the user. */
  hi: "#ffc21a",
  hiSoft: "#fff3cc",
  cobalt: "#2f5bff",
  go: "#1f9d55",
  stop: "#d93b3b",
  white: "#ffffff",
  /** The full-screen decision's own dark. */
  night: "#15212e",
  nightText: "#b8c2cf",
  nightRaised: "rgba(255,255,255,0.08)",
  /** Red that reads on the night background. */
  nightStop: "#ff8b8b",
} as const;

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

export const shadow = {
  card: Platform.select({
    ios: { shadowColor: "#15212e", shadowOpacity: 0.16, shadowRadius: 18, shadowOffset: { width: 0, height: 10 } },
    default: { elevation: 6 },
  }) as object,
  float: Platform.select({
    ios: { shadowColor: "#15212e", shadowOpacity: 0.28, shadowRadius: 14, shadowOffset: { width: 0, height: 6 } },
    default: { elevation: 8 },
  }) as object,
};

/** The smallest a touch target is (Apple's 44, Material's 48: the larger). */
export const MIN_TARGET = 48;
