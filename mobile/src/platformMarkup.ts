/** Taking a picture of the photo with its strokes on it (react-native-view-shot): the file it makes is then made small like any other. */
import { PixelRatio } from "react-native";
import { captureRef } from "react-native-view-shot";
import { shrinkImage } from "./platformImages";
import type { PickedImage } from "./view/attachments";

/** The marked-up photo as it is sent: what `view` shows (`width` by `height` points), as a JPEG made small. Rejects when it can't be taken. */
export async function captureMarkedUp(view: Parameters<typeof captureRef>[0], width: number, height: number): Promise<PickedImage> {
  const uri = await captureRef(view, { format: "jpg", quality: 1, result: "tmpfile" });
  const ratio = PixelRatio.get();
  return shrinkImage(uri, Math.round(width * ratio), Math.round(height * ratio));
}
