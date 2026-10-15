/** Colour sums for themes: mixing, contrast and nudging a colour until it reads. Colours are "#rrggbb" or "#rrggbbaa". */

export type Rgb = [number, number, number];

/** A colour's red, green and blue (0–255); the alpha, if it has one, is dropped. Anything that isn't a hex colour is black. */
export function parseHex(hex: string): Rgb {
  const h = hex.trim().replace(/^#/, "");
  const full = h.length === 3 || h.length === 4 ? [...h].map((c) => c + c).join("") : h;
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(full)) return [0, 0, 0];
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16)) as Rgb;
}

const byte = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");

export const toHex = ([r, g, b]: Rgb) => `#${byte(r)}${byte(g)}${byte(b)}`;

export const isHex = (value: string) => normalizeHex(value) !== null;

/** `a` with `amount` (0–1) of `b` mixed in. */
export function mix(a: string, b: string, amount: number): string {
  const [ca, cb] = [parseHex(a), parseHex(b)];
  return toHex(ca.map((c, i) => c + (cb[i] - c) * amount) as Rgb);
}

/** The colour at `amount` (0–1) opacity, as "#rrggbbaa". */
export const alpha = (hex: string, amount: number) => `${toHex(parseHex(hex))}${byte(amount * 255)}`;

/** Relative luminance, as WCAG defines it: 0 for black, 1 for white. */
export function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG's contrast ratio between two colours: 1 (the same) to 21 (black on white). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Whether a background is dark, i.e. light text reads better on it than dark text. */
export const isDark = (bg: string) => contrast(bg, "#ffffff") > contrast(bg, "#000000");

/** Black or white, whichever reads better on `bg`. */
export const readableOn = (bg: string) => (contrast(bg, "#ffffff") >= contrast(bg, "#000000") ? "#ffffff" : "#000000");

/**
 * `color`, moved toward `toward` (default: white or black, whichever reads better on `bg`) just far enough to reach `min`
 * contrast on `bg`. Left as it is when it already does.
 */
export function ensureContrast(color: string, bg: string, min: number, toward = readableOn(bg)): string {
  if (contrast(color, bg) >= min) return toHex(parseHex(color));
  const target = toward;
  for (let step = 1; step <= 20; step++) {
    const next = mix(color, target, step / 20);
    if (contrast(next, bg) >= min) return next;
  }
  return target;
}

/** A hex colour as "#rrggbb" in lower case (a short "#rgb" is expanded), or null when it isn't one: nothing else is let through. */
export function normalizeHex(value: unknown): string | null {
  if (typeof value !== "string" || !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)) return null;
  const h = value.slice(1).toLowerCase();
  return `#${h.length === 3 ? [...h].map((c) => c + c).join("") : h}`;
}
