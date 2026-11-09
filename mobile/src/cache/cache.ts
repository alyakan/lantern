/**
 * What the phone asked the Mac for and may show again before the Mac answers afresh. A resource shows what was kept at once
 * (in memory, else from the store), then asks the Mac behind it unless what was kept is fresh enough; a pull always asks. Kept
 * entries carry when they were saved and a version: one written by an older shape of the app, or that no longer looks like
 * what it should, is dropped rather than shown. Everything goes when the phone is unpaired or paired with another Mac, and an
 * answer that lands after that is not kept.
 *
 * Screens never see this: they read a resource through a hook made for what they show (see data/).
 */
import type { CacheStore } from "./store";

/** Bumped when what is kept changes shape: entries from before are dropped. */
export const CACHE_VERSION = 1;

interface Envelope {
  v: number;
  at: number;
  value: unknown;
}

export interface ResourceSpec<T> {
  /** Where it is kept: unique per thing asked for (e.g. "insights.week"). */
  key: string;
  /** Asks the Mac for it. */
  fetch: () => Promise<T>;
  /** How old what is kept may be before it is asked for again on being looked at. */
  freshMs: number;
  /** Whether what was kept still looks like it should (it may be from an older Mac or app). */
  check: (value: unknown) => value is T;
}

export interface ResourceState<T> {
  value: T | null;
  /** When `value` was answered (the phone's clock), or null with no value. */
  savedAt: number | null;
  /** The Mac is being asked. */
  loading: boolean;
  /** Why the last ask failed, while it stands. */
  error: string | null;
}

const EMPTY: ResourceState<never> = { value: null, savedAt: null, loading: false, error: null };

export class Resource<T> {
  private state: ResourceState<T> = EMPTY;
  private listeners = new Set<() => void>();
  private restored: Promise<void> | null = null;
  private asking: Promise<void> | null = null;

  constructor(
    private readonly cache: Cache,
    private readonly spec: ResourceSpec<T>,
  ) {}

  getState = (): ResourceState<T> => this.state;

  /** The cache's clock, to say how old `savedAt` is. */
  now = () => this.cache.now();

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };

  /** Shows what was kept, and asks the Mac unless that is fresh enough (or `force`, a pull). */
  async load({ force = false }: { force?: boolean } = {}): Promise<void> {
    const epoch = this.cache.epoch;
    await this.restore();
    if (epoch !== this.cache.epoch) return;
    const s = this.state;
    const fresh = s.value !== null && s.savedAt !== null && this.cache.now() - s.savedAt < this.spec.freshMs;
    if (fresh && !force && !s.error) return;
    await this.ask();
  }

  /** Back to nothing (the cache was cleared). */
  reset() {
    this.restored = null;
    this.asking = null;
    this.set(EMPTY);
  }

  private restore(): Promise<void> {
    this.restored ??= (async () => {
      const epoch = this.cache.epoch;
      const kept = await this.cache.read(this.spec.key, this.spec.check);
      // A newer answer, or a clear, while it read wins.
      if (!kept || epoch !== this.cache.epoch || this.state.value !== null) return;
      this.set({ ...this.state, value: kept.value, savedAt: kept.at });
    })();
    return this.restored;
  }

  private ask(): Promise<void> {
    this.asking ??= (async () => {
      const epoch = this.cache.epoch;
      this.set({ ...this.state, loading: true, error: null });
      try {
        const value = await this.spec.fetch();
        if (epoch !== this.cache.epoch) return;
        const at = this.cache.now();
        this.set({ value, savedAt: at, loading: false, error: null });
        await this.cache.write(this.spec.key, value, at, epoch);
      } catch (e) {
        if (epoch !== this.cache.epoch) return;
        this.set({ ...this.state, loading: false, error: (e as Error).message });
      } finally {
        if (epoch === this.cache.epoch) this.asking = null;
      }
    })();
    return this.asking;
  }

  private set(s: ResourceState<T>) {
    this.state = s;
    for (const l of this.listeners) l();
  }
}

export class Cache {
  /** Bumped by every clear: work begun before one leaves nothing behind. */
  epoch = 0;
  private resources = new Map<string, Resource<unknown>>();

  constructor(
    private readonly store: CacheStore,
    readonly now: () => number = Date.now,
  ) {}

  /** The one resource for a key: every screen that shows it shares it. */
  resource<T>(spec: ResourceSpec<T>): Resource<T> {
    let r = this.resources.get(spec.key) as Resource<T> | undefined;
    if (!r) {
      r = new Resource(this, spec);
      this.resources.set(spec.key, r as Resource<unknown>);
    }
    return r;
  }

  async read<T>(key: string, check: (v: unknown) => v is T): Promise<{ value: T; at: number } | null> {
    let raw: string | null;
    try {
      raw = await this.store.read(key);
    } catch {
      return null;
    }
    if (raw === null) return null;
    try {
      const e = JSON.parse(raw) as Partial<Envelope> | null;
      if (e && e.v === CACHE_VERSION && typeof e.at === "number" && check(e.value)) return { value: e.value, at: e.at };
    } catch {
      // Not readable: dropped below.
    }
    void this.store.remove(key).catch(() => {});
    return null;
  }

  /** Keeps a value, unless the cache was cleared since `epoch` (it would bring back what was forgotten). */
  async write(key: string, value: unknown, at: number, epoch = this.epoch): Promise<void> {
    if (epoch !== this.epoch) return;
    const envelope: Envelope = { v: CACHE_VERSION, at, value };
    try {
      await this.store.write(key, JSON.stringify(envelope));
      // Cleared while it wrote: what it wrote goes too.
      if (epoch !== this.epoch) await this.store.remove(key);
    } catch {
      // Not kept: it holds in memory until the app closes.
    }
  }

  /** Everything goes: the phone was unpaired, or paired with another Mac. */
  async clear(): Promise<void> {
    this.epoch++;
    for (const r of this.resources.values()) r.reset();
    try {
      await this.store.clear();
    } catch {
      // Left in the caches folder until the next clear, or until iOS empties it. It stays on this phone either way.
    }
  }
}
