/**
 * The app lock: an optional Face ID (or fingerprint, or the phone's passcode) check before Lantern shows anything. The phone
 * can approve what Claude does on the Mac, so someone holding it unlocked-for-a-moment shouldn't also get that.
 *
 * It is a lock on the screen only: the connection to the Mac keeps running underneath, so a chat is up to date when the
 * phone is unlocked. Everything the real phone does (the biometrics, the Keychain) sits behind two small seams, so the
 * rules here are tested alone.
 */

/** What the phone can check someone with. */
export type Strength = "none" | "passcode" | "biometric";
/** How a check ended. "unavailable" is a phone with nothing to check with (no passcode set). */
export type AuthResult = "ok" | "cancelled" | "failed" | "unavailable";

export interface LockPlatform {
  strength(): Promise<Strength>;
  /** What to call the check in words: "Face ID", "Touch ID", "your fingerprint or face", "your passcode". */
  method(): Promise<string>;
  /** Asks the person to prove who they are. The phone's passcode is always an alternative, so nobody is locked out. */
  authenticate(reason: string): Promise<AuthResult>;
}

/** Whether the lock is switched on, kept on this phone only. */
export interface LockMemory {
  load(): Promise<boolean>;
  save(on: boolean): Promise<void>;
}

/** How long the app can be out of sight before it asks again. Short enough to matter, long enough for a quick look elsewhere. */
export const GRACE_MS = 30_000;

export interface LockState {
  /** Whether the setting has been read: until then the screen is covered, never shown. */
  ready: boolean;
  enabled: boolean;
  locked: boolean;
  /** The app is not in front (the app switcher takes its picture now): covered, so no chat shows in it. */
  covered: boolean;
  authenticating: boolean;
  /** What to call the check ("Face ID"). */
  method: string;
  /** Whether the phone can check someone at all (the switch is off-limits when it can't). */
  available: boolean;
  /** Why the last thing didn't work, in words. */
  problem: string | null;
}

const REASON = "Unlock Lantern";

export class AppLock {
  private state: LockState = { ready: false, enabled: false, locked: true, covered: false, authenticating: false, method: "your passcode", available: false, problem: null };
  private listeners = new Set<() => void>();
  /** When the app went to the background (only time in the background counts: the Face ID prompt itself makes the app inactive for a moment). */
  private leftAt: number | null = null;

  constructor(
    private platform: LockPlatform,
    private memory: LockMemory,
    private now: () => number = Date.now,
    private grace: number = GRACE_MS,
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  getState = () => this.state;

  private set(patch: Partial<LockState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  /** Reads the setting. Locked from the start when it is on. A setting that can't be read counts as on: not knowing is not a reason to show everything. */
  async start() {
    // What can't be read (the setting, or what the phone can check with) counts as "can lock": showing everything is the worse mistake.
    const [enabled, strength, method] = await Promise.all([this.memory.load().catch(() => true), this.strength(), this.platform.method().catch(() => "your passcode")]);
    // A phone that really has no passcode can't check anyone, and a lock that can't be opened would be a trap: it stays open.
    const locks = enabled && strength !== "none";
    this.set({ ready: true, enabled, locked: locks, method, available: strength !== "none" });
  }

  /** What the phone can check someone with now; a phone that won't say is taken to have a passcode. */
  private async strength(): Promise<Strength> {
    return this.platform.strength().catch((): Strength => "passcode");
  }

  /**
   * The app's state changed (react-native's AppState). While a check is being made only a trip to the background is noted:
   * the prompt itself makes the app inactive and active again, and that must not lock it, but really leaving must.
   */
  appState(next: "active" | "inactive" | "background" | string) {
    const s = this.state;
    if (!s.ready || !s.enabled) return;
    if (s.authenticating) {
      if (next === "background") this.leftAt ??= this.now();
      return;
    }
    if (next === "active") {
      // A clock set back counts as time away too: it can be changed on a phone that is unlocked for a moment.
      const away = this.leftAt === null ? 0 : this.now() - this.leftAt;
      this.leftAt = null;
      this.set({ covered: false, locked: s.locked || away < 0 || away >= this.grace });
    } else if (next === "inactive") {
      this.set({ covered: true });
    } else {
      this.leftAt ??= this.now();
      this.set({ covered: true });
    }
  }

  private async check(): Promise<AuthResult> {
    this.set({ authenticating: true, problem: null });
    try {
      return await this.platform.authenticate(REASON);
    } catch {
      return "failed";
    } finally {
      this.set({ authenticating: false });
    }
  }

  /**
   * "Unavailable" is a code, and a phone with a passcode can give it too (not enrolled, a hiccup): the phone is asked what
   * it can check with, and only one that really has nothing counts as having no lock to open.
   */
  private async nothingToCheckWith(result: AuthResult): Promise<boolean> {
    return result === "unavailable" && (await this.strength()) === "none";
  }

  /** The person asks to get in. Stays locked unless the check passes. */
  async unlock() {
    if (this.state.authenticating || !this.state.locked) return;
    const result = await this.check();
    if (result === "ok") {
      this.leftAt = null;
      this.set({ locked: false, covered: false });
    } else if (await this.nothingToCheckWith(result)) this.set({ locked: false, covered: false, available: false });
    else if (result === "failed") this.set({ problem: "That didn't work. Try again." });
    else if (result === "unavailable") this.set({ problem: "Couldn't check right now. Try again." });
  }

  /** Turns the lock on, after a check that proves it works (so it can't lock someone out the first time). */
  async enable() {
    if (this.state.authenticating) return;
    const available = (await this.strength()) !== "none";
    this.set({ available });
    if (!available) {
      this.set({ problem: "Set a passcode on this phone first: the lock uses it." });
      return;
    }
    const result = await this.check();
    if (result === "ok") {
      try {
        await this.memory.save(true);
        this.leftAt = null;
        this.set({ enabled: true, locked: false });
      } catch {
        this.set({ problem: "Couldn't save that. Try again." });
      }
    } else if (result === "failed") this.set({ problem: "That didn't work. The lock stays off." });
    else if (result === "unavailable") this.set({ problem: "Couldn't check right now. The lock stays off." });
  }

  /** Turns the lock off, after a check: someone holding an unlocked phone for a moment can't remove it. */
  async disable() {
    if (this.state.authenticating) return;
    const result = await this.check();
    if (result === "ok" || (await this.nothingToCheckWith(result))) {
      try {
        await this.memory.save(false);
        this.leftAt = null;
        this.set({ enabled: false, locked: false, covered: false });
      } catch {
        this.set({ problem: "Couldn't save that. Try again." });
      }
    } else if (result === "failed") this.set({ problem: "That didn't work. The lock stays on." });
    else if (result === "unavailable") this.set({ problem: "Couldn't check right now. The lock stays on." });
  }
}

/** Where no real lock was given (the screens' tests): a phone that can't check anyone, with the lock off. */
export const noLockPlatform: LockPlatform = { strength: async () => "none", method: async () => "your passcode", authenticate: async () => "unavailable" };
export const noLockMemory: LockMemory = { load: async () => false, save: async () => {} };
