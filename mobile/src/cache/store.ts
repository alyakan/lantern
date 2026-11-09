/**
 * Where the cache keeps its entries: text under a key. The cache (cache.ts) knows nothing of files; the app gives it the
 * file-backed store (fileStore.ts), the tests this one in memory.
 */
export interface CacheStore {
  /** The text kept under a key, or null when there is none (or it can't be read). */
  read(key: string): Promise<string | null>;
  write(key: string, text: string): Promise<void>;
  remove(key: string): Promise<void>;
  /** Every entry goes. */
  clear(): Promise<void>;
}

/** Entries in memory: the tests' stand-in for the files, and what a phone without them falls back on. */
export class MemoryCacheStore implements CacheStore {
  readonly entries = new Map<string, string>();
  async read(key: string) {
    return this.entries.get(key) ?? null;
  }
  async write(key: string, text: string) {
    this.entries.set(key, text);
  }
  async remove(key: string) {
    this.entries.delete(key);
  }
  async clear() {
    this.entries.clear();
  }
}
