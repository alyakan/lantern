/**
 * The photos this phone sent, kept on it so a message can show them again. The Mac gets the pictures and tells every device only
 * how many there were, so once a chat is opened afresh a message of yours had nothing to show but "1 photo sent". The pictures are
 * copied into the app's own folder (the cache they were made in can be emptied) and listed beside them, newest last; the oldest
 * go when there are too many. A message is found by its chat and its words.
 */
import { Directory, File, Paths } from "expo-file-system";
import type { PickedImage } from "./attachments";

const FOLDER = "lantern-sent-photos";
const INDEX = "index.json";
/** How many messages with photos are kept. */
export const KEPT = 60;

export type SentEntry = { slot: string; text: string; files: string[] };

const folder = () => new Directory(Paths.document, FOLDER);

/** What is kept, oldest first; nothing when it can't be read. */
export async function loadSent(): Promise<SentEntry[]> {
  try {
    const index = new File(folder(), INDEX);
    if (!index.exists) return [];
    const list = JSON.parse(await index.text());
    return Array.isArray(list) ? list.filter((e): e is SentEntry => !!e && typeof e.slot === "string" && typeof e.text === "string" && Array.isArray(e.files)) : [];
  } catch {
    return [];
  }
}

/** Keeps the photos of a message just sent. Never throws: a photo that can't be kept is just not shown again later. */
export async function rememberSent(slot: string, text: string, images: PickedImage[]): Promise<SentEntry[]> {
  try {
    const dir = folder();
    dir.create({ intermediates: true, idempotent: true });
    const stamp = Date.now().toString(36);
    const files: string[] = [];
    images.forEach((image, i) => {
      const name = `${stamp}-${i}.jpg`;
      const from = new File(image.uri);
      // (A picture the cache already let go of is just not kept.)
      if (!from.exists) return;
      from.copy(new File(dir, name));
      files.push(name);
    });
    if (files.length === 0) return loadSent();
    const list = [...(await loadSent()), { slot, text, files }];
    for (const old of list.splice(0, Math.max(0, list.length - KEPT))) for (const name of old.files) forget(dir, name);
    await new File(dir, INDEX).write(JSON.stringify(list));
    return list;
  } catch {
    return loadSent();
  }
}

function forget(dir: Directory, name: string) {
  try {
    const file = new File(dir, name);
    if (file.exists) file.delete();
  } catch {
    // Already gone.
  }
}

/**
 * The photos for the messages of one chat that say they had some, by message id. Messages are matched to what was kept by their
 * words, the newest to the newest: two messages with the same words (or none, a photo on its own) get their own, in order.
 */
export function photosFor(list: SentEntry[], slot: string, messages: { id: string; text: string }[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const byText = new Map<string, SentEntry[]>();
  for (const e of list) if (e.slot === slot) byText.set(e.text, [...(byText.get(e.text) ?? []), e]);
  const rows = new Map<string, string[]>();
  for (const m of messages) rows.set(m.text, [...(rows.get(m.text) ?? []), m.id]);
  for (const [text, ids] of rows) {
    const kept = byText.get(text) ?? [];
    // The newest message gets the newest entry: line the two lists up at their ends.
    for (let n = 1; n <= Math.min(ids.length, kept.length); n++) {
      out.set(ids[ids.length - n], kept[kept.length - n].files.map((name) => new File(folder(), name).uri));
    }
  }
  return out;
}
