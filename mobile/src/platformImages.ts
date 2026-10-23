import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { bytesOf, fitLongEdge, IMAGE_BYTES, LONG_EDGE, type PickedImage } from "./view/attachments";

/** Where a picture comes from: the photo library (screenshots are in it), or a photo taken now. */
export type ImageSource = "library" | "camera";

/** What came of asking for pictures: them (none when the person backed out), or why not. */
export type Picked = { images: PickedImage[] } | { problem: "denied" | "failed" };

/** How hard a picture is squeezed, in turn, until it weighs little enough: (longest side, JPEG quality). */
const LADDER: [number, number][] = [
  [LONG_EDGE, 0.8],
  [LONG_EDGE, 0.6],
  [LONG_EDGE, 0.4],
  [1024, 0.5],
];

let counter = 0;

/**
 * A picked picture as it is sent: a JPEG whose longest side is at most LONG_EDGE and that weighs at most IMAGE_BYTES. It is
 * saved anew, which normally leaves out what the camera wrote into the file (where it was taken, say); that isn't checked
 * here, so it is not promised to anyone.
 */
async function shrink(asset: ImagePicker.ImagePickerAsset): Promise<PickedImage> {
  for (const [edge, quality] of LADDER) {
    const context = ImageManipulator.manipulate(asset.uri);
    const size = fitLongEdge(asset.width, asset.height, edge);
    if (size) context.resize(size);
    const rendered = await context.renderAsync();
    const saved = await rendered.saveAsync({ format: SaveFormat.JPEG, compress: quality, base64: true });
    if (saved.base64 && bytesOf(saved.base64) <= IMAGE_BYTES) {
      counter += 1;
      return { id: `img-${Date.now().toString(36)}-${counter}`, uri: saved.uri, data: saved.base64, mediaType: "image/jpeg", width: saved.width, height: saved.height };
    }
  }
  throw new Error("too big");
}

/**
 * Asks for up to `room` pictures: the library's picker (it needs no permission: the person gives it only the ones they
 * choose), or the camera (which does). Each comes back already made small.
 */
export async function pickImages(source: ImageSource, room: number): Promise<Picked> {
  if (room <= 0) return { images: [] };
  try {
    let result: ImagePicker.ImagePickerResult;
    if (source === "camera") {
      const allowed = await ImagePicker.requestCameraPermissionsAsync();
      if (!allowed.granted) return { problem: "denied" };
      result = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 1 });
    } else {
      result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: room > 1, selectionLimit: room, orderedSelection: true, quality: 1 });
    }
    if (result.canceled) return { images: [] };
    const images: PickedImage[] = [];
    for (const asset of result.assets.slice(0, room)) images.push(await shrink(asset));
    return { images };
  } catch {
    return { problem: "failed" };
  }
}
