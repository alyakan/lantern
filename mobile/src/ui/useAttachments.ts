import { useCallback, useEffect, useRef, useState } from "react";
import { pickImages, type ImageSource } from "../platformImages";
import { MAX_IMAGES, type PickedImage } from "../view/attachments";

/** What went wrong, in words for the line under the message box; `settings` says that Settings is where it is fixed. */
export type AttachProblem = { words: string; settings: boolean };

/**
 * The pictures attached to the message being written: up to MAX_IMAGES, added from the library or the camera (`add`),
 * taken off again (`remove`), and dropped when the message is sent (`clear`). `busy` while the picker is up or a picture is
 * being made small.
 */
export function useAttachments() {
  const [images, setImages] = useState<PickedImage[]>([]);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<AttachProblem | null>(null);
  const alive = useRef(true);
  const left = useRef(MAX_IMAGES);
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);
  left.current = MAX_IMAGES - images.length;

  const add = useCallback(async (source: ImageSource) => {
    if (left.current <= 0) return;
    setProblem(null);
    setBusy(true);
    const got = await pickImages(source, left.current);
    if (!alive.current) return;
    setBusy(false);
    if ("problem" in got) {
      setProblem(
        got.problem === "denied"
          ? { words: "Lantern can't use the camera. Turn it on for Lantern in Settings.", settings: true }
          : { words: "That picture couldn't be used. Try another.", settings: false },
      );
      return;
    }
    // Never more than are allowed, whatever the picker gave back.
    setImages((now) => [...now, ...got.images].slice(0, MAX_IMAGES));
  }, []);

  return {
    images,
    busy,
    problem,
    full: images.length >= MAX_IMAGES,
    add,
    remove: (id: string) => setImages((now) => now.filter((i) => i.id !== id)),
    // A marked-up photo takes the place of the one it was made from.
    replace: (id: string, image: PickedImage) => setImages((now) => now.map((i) => (i.id === id ? image : i))),
    clear: useCallback(() => setImages([]), []),
    dismiss: () => setProblem(null),
  };
}
