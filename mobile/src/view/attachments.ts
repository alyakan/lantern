/** How many pictures one message may carry (the Mac refuses more: see protocol.rs IMAGES_MAX). */
export const MAX_IMAGES = 4;
/** The longest side a picture is sent at, in pixels: what Claude reads best, and small enough to go in a moment. */
export const LONG_EDGE = 1568;
/**
 * The most one picture may weigh once it is made small, in bytes. Four of them stay inside what the Mac takes
 * (IMAGES_TOTAL_MAX, 5 MB) with room to spare.
 */
export const IMAGE_BYTES = 1_200_000;

/** A picture picked for a message, already made small: `data` is its JPEG in base64, `uri` a file to show it from. */
export type PickedImage = { id: string; uri: string; data: string; mediaType: "image/jpeg"; width: number; height: number };

/**
 * The size to shrink a picture to so its longest side is `max`, keeping its shape; null when it is that small already (a
 * picture is never made bigger).
 */
export function fitLongEdge(width: number, height: number, max: number = LONG_EDGE): { width: number; height: number } | null {
  const long = Math.max(width, height);
  if (!(long > max) || !(width > 0) || !(height > 0)) return null;
  const scale = max / long;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** How many bytes a base64 string stands for. */
export const bytesOf = (base64: string) => Math.floor((base64.length * 3) / 4) - (base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0);

/** "1 photo", "3 photos": what a message with pictures says it carries. */
export const photos = (n: number) => (n === 1 ? "1 photo" : `${n} photos`);
