/**
 * Pictures pasted into the box, as Claude Code's terminal takes them: each shows in the text as `[Image #1]` and goes to
 * Claude as an image of its own with the message. A picture is shrunk before it goes (the backend takes 3 MB a picture,
 * 4 a message, as from a phone: see remote::protocol::check_images).
 */

export interface PastedImage {
  /** "image/png" or "image/jpeg". */
  media_type: string;
  /** Its bytes in base64, without a data: prefix. */
  data: string;
}

/** How many pictures a message carries at most (remote::protocol::IMAGES_MAX). */
export const IMAGES_MAX = 4;
/** The longest side a picture is sent at: Claude scales anything bigger down to about this anyway. */
export const LONG_SIDE = 1568;
/** Kept under the backend's 3 MB a picture, in base64 characters. */
const DATA_MAX = Math.floor(((3 << 20) * 4) / 3) - 1024;

/** What a picture shows as in the box: `[Image #2]`. */
export const imageToken = (n: number) => `[Image #${n}]`;

/** The next free picture number: one past the highest that's in the box or kept. */
export function nextImage(text: string, kept: Record<number, PastedImage>): number {
  const inText = [...text.matchAll(/\[Image #(\d+)\]/g)].map((m) => Number(m[1]));
  return Math.max(0, ...inText, ...Object.keys(kept).map(Number)) + 1;
}

/** The kept pictures whose token is still in `text`, in the order they appear there (one deleted from the box isn't sent). */
export function imagesIn(text: string, kept: Record<number, PastedImage>): PastedImage[] {
  const seen = new Set<number>();
  const out: PastedImage[] = [];
  for (const m of text.matchAll(/\[Image #(\d+)\]/g)) {
    const n = Number(m[1]);
    if (kept[n] && !seen.has(n)) {
      seen.add(n);
      out.push(kept[n]);
    }
  }
  return out;
}

/** The size a picture is drawn at: as it is, or scaled so its long side is `LONG_SIDE`. */
export function fitted(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(1, LONG_SIDE / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** A pasted picture made ready to send: scaled down, as PNG, or as JPEG when the PNG would be too big. Null if it can't be. */
export async function shrinkImage(blob: Blob): Promise<PastedImage | null> {
  try {
    const bitmap = await createImageBitmap(blob);
    const { width, height } = fitted(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    for (const [type, quality] of [["image/png", undefined], ["image/jpeg", 0.85], ["image/jpeg", 0.6]] as const) {
      const data = canvas.toDataURL(type, quality).split(",")[1] ?? "";
      if (data && data.length <= DATA_MAX) return { media_type: type, data };
    }
    return null;
  } catch {
    return null;
  }
}
