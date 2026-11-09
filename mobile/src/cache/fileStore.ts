/**
 * The cache's entries as files, one per key, in the app's caches folder: on this phone only (iOS never backs that folder up,
 * and may empty it when space runs short, which a cache can bear). Keys become file names through base64url, so a key with
 * a project's name in it can't reach outside the folder.
 */
import { Directory, File, Paths } from "expo-file-system";
import { toBase64Url, utf8Encode } from "../platform/utf8";
import type { CacheStore } from "./store";

const FOLDER = "lantern-cache";

export function fileNameOf(key: string): string {
  return `${toBase64Url(utf8Encode(key))}.json`;
}

export function createFileCacheStore(root: () => Directory = () => new Directory(Paths.cache, FOLDER)): CacheStore {
  const fileOf = (key: string) => new File(root(), fileNameOf(key));
  return {
    async read(key) {
      try {
        const file = fileOf(key);
        return file.exists ? await file.text() : null;
      } catch {
        return null;
      }
    },
    async write(key, text) {
      root().create({ intermediates: true, idempotent: true });
      await fileOf(key).write(text);
    },
    async remove(key) {
      const file = fileOf(key);
      if (file.exists) file.delete();
    },
    async clear() {
      const dir = root();
      if (dir.exists) dir.delete();
    },
  };
}
