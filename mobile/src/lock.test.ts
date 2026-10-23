import { AppLock, GRACE_MS, type AuthResult, type LockMemory, type LockPlatform, type Strength } from "./lock";

function rig(opts: { enabled?: boolean; strength?: Strength; results?: AuthResult[]; loadFails?: boolean } = {}) {
  // What the phone says it can check with, changeable between calls.
  const phone = { strength: opts.strength ?? ("biometric" as Strength), strengthFails: false };
  let clock = 1_000_000;
  const saved: boolean[] = [];
  const asked: string[] = [];
  const results = [...(opts.results ?? [])];
  const platform: LockPlatform = {
    strength: async () => {
      if (phone.strengthFails) throw new Error("hiccup");
      return phone.strength;
    },
    method: async () => "Face ID",
    authenticate: async (reason) => {
      asked.push(reason);
      return results.shift() ?? "ok";
    },
  };
  const memory: LockMemory = {
    load: async () => {
      if (opts.loadFails) throw new Error("keychain");
      return opts.enabled ?? false;
    },
    save: async (on) => void saved.push(on),
  };
  const lock = new AppLock(platform, memory, () => clock);
  return { lock, saved, asked, phone, advance: (ms: number) => void (clock += ms) };
}

describe("the app lock", () => {
  it("is covered until its setting is read, then open when it is off", async () => {
    const { lock } = rig();
    expect(lock.getState()).toMatchObject({ ready: false, locked: true });
    await lock.start();
    expect(lock.getState()).toMatchObject({ ready: true, enabled: false, locked: false, method: "Face ID", available: true });
  });

  it("is locked from the start when it is on", async () => {
    const { lock } = rig({ enabled: true });
    await lock.start();
    expect(lock.getState()).toMatchObject({ enabled: true, locked: true });
  });

  it("counts a setting it can't read as on: not knowing is not a reason to show everything", async () => {
    const { lock } = rig({ loadFails: true });
    await lock.start();
    expect(lock.getState()).toMatchObject({ enabled: true, locked: true });
  });

  it("stays open on a phone with no passcode: a lock that can't be opened is a trap", async () => {
    const { lock } = rig({ enabled: true, strength: "none" });
    await lock.start();
    expect(lock.getState()).toMatchObject({ enabled: true, locked: false, available: false });
  });

  it("stays locked when it can't tell what the phone can check with: that is not a reason to show everything", async () => {
    const { lock, phone } = rig({ enabled: true });
    phone.strengthFails = true;
    await lock.start();
    expect(lock.getState()).toMatchObject({ enabled: true, locked: true, available: true });
  });

  it("opens on an \"unavailable\" check only when the phone really has nothing to check with, and asks again otherwise", async () => {
    const { lock, phone } = rig({ enabled: true, results: ["unavailable", "unavailable"] });
    await lock.start();
    await lock.unlock();
    expect(lock.getState()).toMatchObject({ locked: true, problem: "Couldn't check right now. Try again." });
    phone.strength = "none";
    await lock.unlock();
    expect(lock.getState()).toMatchObject({ locked: false, available: false });
  });

  it("is not dropped by an \"unavailable\" check on a phone that still has a passcode", async () => {
    const { lock, saved } = rig({ enabled: true, results: ["ok", "unavailable"] });
    await lock.start();
    await lock.unlock();
    await lock.disable();
    expect(lock.getState()).toMatchObject({ enabled: true, problem: "Couldn't check right now. The lock stays on." });
    expect(saved).toEqual([]);
  });

  it("asks the phone again when it is turned on, not what it said at launch", async () => {
    const { lock, phone } = rig({ strength: "none", results: ["ok"] });
    await lock.start();
    expect(lock.getState().available).toBe(false);
    phone.strength = "passcode";
    await lock.enable();
    expect(lock.getState()).toMatchObject({ available: true, enabled: true });
  });

  it("locks when the clock was set back while it was away", async () => {
    const { lock, advance } = rig({ enabled: true });
    await lock.start();
    await lock.unlock();
    lock.appState("background");
    advance(-3_600_000);
    lock.appState("active");
    expect(lock.getState().locked).toBe(true);
  });

  it("locks after going to the background during a check that is turned off, and not after the check's own prompt", async () => {
    const { lock, advance, phone } = rig({ enabled: true });
    await lock.start();
    await lock.unlock();
    let release: (r: AuthResult) => void = () => {};
    const platform = (lock as unknown as { platform: LockPlatform }).platform;
    platform.authenticate = () => new Promise<AuthResult>((r) => (release = r));
    const disabling = lock.disable();
    lock.appState("background");
    advance(GRACE_MS * 2);
    release("cancelled");
    await disabling;
    lock.appState("active");
    expect(lock.getState()).toMatchObject({ enabled: true, locked: true });
    expect(phone.strength).toBe("biometric");
  });

  it("opens with a passing check and stays locked after a cancelled or failed one, saying so only for a failure", async () => {
    const { lock, asked } = rig({ enabled: true, results: ["cancelled", "failed", "ok"] });
    await lock.start();
    await lock.unlock();
    expect(lock.getState()).toMatchObject({ locked: true, problem: null });
    await lock.unlock();
    expect(lock.getState()).toMatchObject({ locked: true, problem: "That didn't work. Try again." });
    await lock.unlock();
    expect(lock.getState()).toMatchObject({ locked: false, problem: null, authenticating: false });
    expect(asked).toHaveLength(3);
  });

  it("asks once at a time", async () => {
    const { lock, asked } = rig({ enabled: true });
    await lock.start();
    await Promise.all([lock.unlock(), lock.unlock()]);
    expect(asked).toHaveLength(1);
  });

  it("locks again after half a minute in the background, and not after a quick look away", async () => {
    const { lock, advance } = rig({ enabled: true });
    await lock.start();
    await lock.unlock();
    lock.appState("background");
    expect(lock.getState()).toMatchObject({ covered: true, locked: false });
    advance(GRACE_MS - 1000);
    lock.appState("active");
    expect(lock.getState()).toMatchObject({ covered: false, locked: false });
    lock.appState("background");
    advance(GRACE_MS);
    lock.appState("active");
    expect(lock.getState()).toMatchObject({ covered: false, locked: true });
  });

  it("covers the app while it is inactive (the app switcher's picture), without counting it as time away", async () => {
    const { lock, advance } = rig({ enabled: true });
    await lock.start();
    await lock.unlock();
    lock.appState("inactive");
    expect(lock.getState().covered).toBe(true);
    advance(GRACE_MS * 10);
    lock.appState("active");
    expect(lock.getState()).toMatchObject({ covered: false, locked: false });
  });

  it("is not locked again by the check's own prompt, which makes the app inactive and active again", async () => {
    const { lock, advance } = rig({ enabled: true });
    await lock.start();
    let release: (r: AuthResult) => void = () => {};
    const platform = (lock as unknown as { platform: LockPlatform }).platform;
    platform.authenticate = () => new Promise<AuthResult>((r) => (release = r));
    const unlocking = lock.unlock();
    // What iOS does around Face ID, with a long wait on the prompt.
    lock.appState("inactive");
    lock.appState("background");
    advance(GRACE_MS * 2);
    lock.appState("active");
    release("ok");
    await unlocking;
    expect(lock.getState()).toMatchObject({ locked: false, covered: false });
    lock.appState("active");
    expect(lock.getState().locked).toBe(false);
  });

  it("is not locked by time away when it is off", async () => {
    const { lock, advance } = rig();
    await lock.start();
    lock.appState("background");
    advance(GRACE_MS * 5);
    lock.appState("active");
    expect(lock.getState()).toMatchObject({ locked: false, covered: false });
  });

  it("is turned on only after a check, and saved", async () => {
    const { lock, saved, asked } = rig({ results: ["ok"] });
    await lock.start();
    await lock.enable();
    expect(asked).toHaveLength(1);
    expect(saved).toEqual([true]);
    expect(lock.getState()).toMatchObject({ enabled: true, locked: false });
  });

  it("stays off when the check that turns it on is cancelled or fails", async () => {
    const { lock, saved } = rig({ results: ["cancelled", "failed"] });
    await lock.start();
    await lock.enable();
    expect(lock.getState().enabled).toBe(false);
    await lock.enable();
    expect(lock.getState()).toMatchObject({ enabled: false, problem: "That didn't work. The lock stays off." });
    expect(saved).toEqual([]);
  });

  it("can't be turned on where the phone has nothing to check with, and says why", async () => {
    const { lock, saved, asked } = rig({ strength: "none" });
    await lock.start();
    await lock.enable();
    expect(lock.getState()).toMatchObject({ enabled: false, problem: "Set a passcode on this phone first: the lock uses it." });
    expect(asked).toEqual([]);
    expect(saved).toEqual([]);
  });

  it("is turned off only after a check, so a phone handed over for a moment can't drop it", async () => {
    const { lock, saved } = rig({ enabled: true, results: ["ok", "cancelled", "failed", "ok"] });
    await lock.start();
    await lock.unlock();
    await lock.disable();
    expect(lock.getState().enabled).toBe(true);
    await lock.disable();
    expect(lock.getState()).toMatchObject({ enabled: true, problem: "That didn't work. The lock stays on." });
    expect(saved).toEqual([]);
    await lock.disable();
    expect(lock.getState()).toMatchObject({ enabled: false, locked: false });
    expect(saved).toEqual([false]);
  });

  it("says when its setting can't be saved, and stays as it was", async () => {
    const { lock } = rig({ results: ["ok"] });
    (lock as unknown as { memory: LockMemory }).memory.save = async () => {
      throw new Error("full");
    };
    await lock.start();
    await lock.enable();
    expect(lock.getState()).toMatchObject({ enabled: false, problem: "Couldn't save that. Try again." });
  });
});

describe("proving it is the owner before something that matters", () => {
  it("asks the phone every time, with the reason, whether or not the app lock is on, and says what it answered", async () => {
    for (const enabled of [false, true]) {
      // With the lock on, the first answer is the unlock's own.
      const { lock, asked } = rig({ enabled, results: enabled ? ["ok", "ok", "failed", "cancelled"] : ["ok", "failed", "cancelled"] });
      await lock.start();
      if (enabled) await lock.unlock();
      asked.length = 0;
      expect(await lock.verify("Run a command on your Mac")).toBe("ok");
      expect(await lock.verify("Run a command on your Mac")).toBe("failed");
      expect(await lock.verify("Run a command on your Mac")).toBe("cancelled");
      expect(asked).toEqual(Array(3).fill("Run a command on your Mac"));
      // It locks and unlocks nothing itself, and it is no longer checking.
      expect(lock.getState()).toMatchObject({ locked: false, authenticating: false });
    }
  });

  it("asks even before the lock has read its setting", async () => {
    const { lock, asked } = rig({ enabled: true });
    expect(await lock.verify("Run it")).toBe("ok");
    expect(asked).toEqual(["Run it"]);
  });

  it("can't be passed by a phone with nothing to check anyone with: it is refused, and nothing is asked", async () => {
    const { lock, asked } = rig({ enabled: false, strength: "none" });
    await lock.start();
    expect(await lock.verify("Run it")).toBe("unavailable");
    expect(asked).toEqual([]);
    expect(lock.getState().authenticating).toBe(false);
  });

  it("counts a check that throws as failed, and a second one asked while one is going as not a second chance", async () => {
    const throwing = rig({ enabled: false });
    await throwing.lock.start();
    (throwing.lock as unknown as { platform: LockPlatform }).platform.authenticate = async () => {
      throw new Error("sensor");
    };
    expect(await throwing.lock.verify("Run it")).toBe("failed");
    const { lock } = rig({ enabled: false });
    await lock.start();
    const first = lock.verify("Run it");
    expect(await lock.verify("Run it")).toBe("cancelled");
    await first;
  });
});
