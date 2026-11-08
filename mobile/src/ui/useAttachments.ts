import { useCallback, useEffect, useRef, useState } from "react";
import { pickImages, type ImageSource } from "../platformImages";
import { MAX_IMAGES, type PickedImage } from "../view/attachments";

/** What went wrong, in words for the line under the message box; `settings` says that Settings is where it is fixed. */
export type AttachProblem = { words: string; settings: boolean };

/**
 * Each chat's pictures attached and not sent, by its slot, while the app runs: a chat left for another (on a tablet, the chat
 * beside the column is a new screen each time) finds them still attached when it comes back, as it finds its words. Only in
 * memory: pictures are big, and the Keychain that keeps the words is no place for them.
 */
const kept = new Map<string, PickedImage[]>();
const keep = (key: string | undefined, images: PickedImage[]) => {
  if (!key) return;
  if (images.length > 0) kept.set(key, images);
  else kept.delete(key);
};

/** For tests: forget every chat's pictures. */
export function resetKeptAttachments() {
  kept.clear();
}

/**
 * The pictures attached to the message being written: up to MAX_IMAGES, added from the library or the camera (`add`),
 * taken off again (`remove`), and dropped when the message is sent (`clear`). `busy` while the picker is up or a picture is
 * being made small. With a `key` (a chat's slot) they are kept for that chat while the app runs.
 */
export function useAttachments(key?: string) {
  const [images, setShown] = useState<PickedImage[]>(() => (key ? (kept.get(key) ?? []) : []));
  // Every change is kept for the chat at once, so leaving it at any moment loses nothing (a picture still being made small is
  // kept for it when it is ready, even if the chat has gone).
  const keyRef = useRef(key);
  keyRef.current = key;
  const setImages = useCallback((next: (now: PickedImage[]) => PickedImage[]) => {
    setShown((now) => {
      const after = next(now);
      keep(keyRef.current, after);
      return after;
    });
  }, []);
  // Another chat's box (the same screen, given another chat): its own pictures.
  const shownFor = useRef(key);
  useEffect(() => {
    if (shownFor.current === key) return;
    shownFor.current = key;
    setShown(key ? (kept.get(key) ?? []) : []);
  }, [key]);

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
    const forKey = keyRef.current;
    const got = await pickImages(source, left.current);
    if (!alive.current) {
      // The chat was left while the picture was being made small: it is kept for the chat all the same.
      if (forKey && !("problem" in got)) keep(forKey, [...(kept.get(forKey) ?? []), ...got.images].slice(0, MAX_IMAGES));
      return;
    }
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
    clear: useCallback(() => setImages(() => []), [setImages]),
    dismiss: () => setProblem(null),
  };
}
