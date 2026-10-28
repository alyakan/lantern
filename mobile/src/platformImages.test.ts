import * as ImagePicker from "expo-image-picker";
import { ImageManipulator } from "expo-image-manipulator";
import { pickImages } from "./platformImages";
import { IMAGE_BYTES, LONG_EDGE } from "./view/attachments";

const picker = ImagePicker as unknown as Record<"requestCameraPermissionsAsync" | "launchCameraAsync" | "launchImageLibraryAsync", jest.Mock>;
const manipulate = ImageManipulator.manipulate as unknown as jest.Mock;

const asset = (name: string, width = 4032, height = 3024) => ({ uri: `file:///${name}.heic`, width, height });
/** What the picker answers: the pictures chosen. */
const chose = (...assets: ReturnType<typeof asset>[]) => ({ canceled: false, assets });

/** What shrinking saves, one answer per try (the last is kept for any more): [base64 text, bytes it weighs]. */
function saves(...answers: [string, number][]) {
  const resizes: unknown[][] = [];
  const saved: unknown[] = [];
  let at = 0;
  manipulate.mockImplementation(() => {
    const [base64] = answers[Math.min(at, answers.length - 1)];
    at += 1;
    return {
      resize: (size: unknown) => void resizes.push([size]),
      renderAsync: async () => ({ saveAsync: async (options: unknown) => (saved.push(options), { uri: `file:///small-${at}.jpg`, width: 1568, height: 1176, base64 }) }),
    };
  });
  return { resizes, saved };
}
/** A base64 string that weighs `bytes`. */
const weighing = (bytes: number) => "A".repeat(Math.ceil((bytes * 4) / 3));

beforeEach(() => {
  for (const f of [picker.requestCameraPermissionsAsync, picker.launchCameraAsync, picker.launchImageLibraryAsync]) f.mockClear();
  picker.requestCameraPermissionsAsync.mockResolvedValue({ granted: true });
  picker.launchCameraAsync.mockResolvedValue({ canceled: true, assets: null });
  picker.launchImageLibraryAsync.mockResolvedValue({ canceled: true, assets: null });
});

describe("picking photos", () => {
  it("opens the library for as many as there is room for, and makes each a small JPEG", async () => {
    const { resizes, saved } = saves(["/9j/4AAQ", 5]);
    picker.launchImageLibraryAsync.mockResolvedValue(chose(asset("a"), asset("b", 800, 600)));
    const got = await pickImages("library", 3);
    expect(picker.launchImageLibraryAsync).toHaveBeenCalledWith(expect.objectContaining({ mediaTypes: ["images"], allowsMultipleSelection: true, selectionLimit: 3 }));
    expect(picker.requestCameraPermissionsAsync).not.toHaveBeenCalled();
    expect("images" in got && got.images).toHaveLength(2);
    if (!("images" in got)) throw new Error("expected pictures");
    expect(got.images[0]).toMatchObject({ mediaType: "image/jpeg", data: "/9j/4AAQ", uri: expect.stringMatching(/^file:\/\/\/small/) });
    expect(new Set(got.images.map((i) => i.id)).size).toBe(2);
    // The big one is brought down to the limit, the small one is left its size, and both are saved as JPEG.
    expect(resizes).toEqual([[{ width: LONG_EDGE, height: 1176 }]]);
    expect(saved[0]).toMatchObject({ format: "jpeg", base64: true });
  });

  it("asks for one at a time when there is room for one", async () => {
    saves(["/9j/4AAQ", 5]);
    picker.launchImageLibraryAsync.mockResolvedValue(chose(asset("a")));
    await pickImages("library", 1);
    expect(picker.launchImageLibraryAsync).toHaveBeenCalledWith(expect.objectContaining({ allowsMultipleSelection: false, selectionLimit: 1 }));
  });

  it("takes no more than there is room for, whatever the picker gives back, and none when there is no room", async () => {
    saves(["/9j/4AAQ", 5]);
    picker.launchImageLibraryAsync.mockResolvedValue(chose(asset("a"), asset("b"), asset("c")));
    expect(await pickImages("library", 2)).toMatchObject({ images: [{}, {}] });
    picker.launchImageLibraryAsync.mockClear();
    expect(await pickImages("library", 0)).toEqual({ images: [] });
    expect(picker.launchImageLibraryAsync).not.toHaveBeenCalled();
  });

  it("gives nothing back, and no complaint, when the person backs out", async () => {
    expect(await pickImages("library", 4)).toEqual({ images: [] });
    expect(await pickImages("camera", 4)).toEqual({ images: [] });
  });

  it("asks the camera's permission first, and says so when it is refused, without opening the camera", async () => {
    picker.requestCameraPermissionsAsync.mockResolvedValue({ granted: false });
    expect(await pickImages("camera", 4)).toEqual({ problem: "denied" });
    expect(picker.launchCameraAsync).not.toHaveBeenCalled();
    picker.requestCameraPermissionsAsync.mockResolvedValue({ granted: true });
    saves(["/9j/4AAQ", 5]);
    picker.launchCameraAsync.mockResolvedValue(chose(asset("shot")));
    expect(await pickImages("camera", 4)).toMatchObject({ images: [{ mediaType: "image/jpeg" }] });
  });

  it("squeezes a picture that is still too heavy until it isn't, and makes it smaller still as a last try", async () => {
    const { resizes, saved } = saves([weighing(IMAGE_BYTES + 1000), 0], [weighing(IMAGE_BYTES + 1), 0], [weighing(1000), 0]);
    picker.launchImageLibraryAsync.mockResolvedValue(chose(asset("noisy")));
    const got = await pickImages("library", 1);
    expect(got).toMatchObject({ images: [{ data: weighing(1000) }] });
    expect(saved.map((s) => (s as { compress: number }).compress)).toEqual([0.8, 0.6, 0.4]);
    expect(resizes).toHaveLength(3);
    // Four tries at most; a picture that stays too heavy is not sent.
    saves([weighing(IMAGE_BYTES * 2), 0]);
    expect(await pickImages("library", 1)).toEqual({ problem: "failed" });
  });

  it("says it failed, rather than throwing, when the picker or the shrinking does", async () => {
    picker.launchImageLibraryAsync.mockRejectedValue(new Error("no"));
    expect(await pickImages("library", 2)).toEqual({ problem: "failed" });
    picker.launchImageLibraryAsync.mockResolvedValue(chose(asset("a")));
    manipulate.mockImplementation(() => ({ resize: jest.fn(), renderAsync: async () => ({ saveAsync: async () => ({ uri: "x", width: 1, height: 1 }) }) }));
    expect(await pickImages("library", 2)).toEqual({ problem: "failed" });
  });
});
