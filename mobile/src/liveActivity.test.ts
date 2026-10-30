import { chatLink, LiveCards, slotOfLink, STALE_MS, SUMMARY_RENEW_MS, type CardFactory, type CardInstance, type CardProps, type World } from "./liveActivity";

/** A card the fake native side started: what it was started with, what became of it, and a way to give it a token. */
class FakeCard implements CardInstance {
  ended: string | null = null;
  listeners: ((e: { activityId: string; pushToken: string }) => void)[] = [];
  removed = 0;
  constructor(
    readonly props: CardProps,
    readonly url: string | undefined,
    public token: string | null = null,
    readonly stale?: Date,
  ) {}
  getId = () => "activity-1";
  getPushToken = async () => this.token;
  addPushTokenListener(listener: (e: { activityId: string; pushToken: string }) => void) {
    this.listeners.push(listener);
    return { remove: () => void this.removed++ };
  }
  end = async (policy?: "default" | "immediate") => void (this.ended = policy ?? "default");
  /** Apple made (or changed) the card's token. */
  gotToken(pushToken: string) {
    this.token = pushToken;
    this.listeners.forEach((l) => l({ activityId: "activity-1", pushToken }));
  }
}

function rig(opts: { tokenAtStart?: string | null; startThrows?: boolean; tellFails?: boolean } = {}) {
  const started: FakeCard[] = [];
  const told: ({ card: { slot: string; token: string; project: string; since: number } | null })[] = [];
  const factory: CardFactory = {
    start: (props, url, stale) => {
      if (opts.startThrows) throw new Error("Live Activities are off");
      const card = new FakeCard(props, url, opts.tokenAtStart ?? null, stale);
      started.push(card);
      return card;
    },
  };
  const cards = new LiveCards({
    factory: () => factory,
    tell: async (state) => {
      told.push(state);
      if (opts.tellFails) throw new Error("offline");
    },
    startTokens: () => null,
    now: () => 5_000,
  });
  return { cards, started, told };
}

describe("the card on the lock screen", () => {
  it("starts as a message is sent: the project's name, Working, since now, a link back to the chat and a stale date", async () => {
    const { cards, started } = rig();
    await cards.begin("m1", "chat 1", "lantern");
    expect(started).toHaveLength(1);
    expect(started[0].props).toEqual({ project: "lantern", status: "working", since: 5_000 });
    expect(started[0].url).toBe("lantern://chat/chat%201");
    expect(started[0].stale?.getTime()).toBe(5_000 + STALE_MS);
    expect(cards.slot).toBe("chat 1");
  });

  it("says Lantern when the project has no name, and trims one that has spaces round it", async () => {
    const { cards, started } = rig();
    await cards.begin("m1", "a", null);
    await cards.begin("m2", "a", "  app  ");
    await cards.begin("m3", "a", "   ");
    expect(started.map((c) => c.props.project)).toEqual(["Lantern", "app", "Lantern"]);
  });

  it("tells the Mac nothing until it has taken the message, even with the token in hand (a chat it hasn't heard of yet looks finished)", async () => {
    const { cards, told } = rig({ tokenAtStart: "cc".repeat(32) });
    await cards.begin("m1", "a", "lantern");
    expect(told).toEqual([]);
    await cards.confirm("m1");
    expect(told).toEqual([{ card: { slot: "a", token: "cc".repeat(32), project: "lantern", since: 5_000 } }]);
  });

  it("tells the Mac the token when Apple makes it, if the message was taken already, and again if it changes, never one it was told", async () => {
    const { cards, started, told } = rig();
    await cards.begin("m1", "a", "lantern");
    await cards.confirm("m1");
    expect(told).toEqual([]);
    started[0].gotToken("aa".repeat(32));
    started[0].gotToken("aa".repeat(32));
    started[0].gotToken("bb".repeat(32));
    await Promise.resolve();
    expect(told).toEqual([
      { card: { slot: "a", token: "aa".repeat(32), project: "lantern", since: 5_000 } },
      { card: { slot: "a", token: "bb".repeat(32), project: "lantern", since: 5_000 } },
    ]);
  });

  it("holds a token that comes before the Mac has answered, and tells it when the message is taken", async () => {
    const { cards, started, told } = rig();
    await cards.begin("m1", "a", "lantern");
    started[0].gotToken("dd".repeat(32));
    await Promise.resolve();
    expect(told).toEqual([]);
    await cards.confirm("m1");
    expect(told).toEqual([{ card: { slot: "a", token: "dd".repeat(32), project: "lantern", since: 5_000 } }]);
  });

  it("takes its card back when the Mac didn't take the message, telling the Mac there is none only if it had been told of one", async () => {
    const quiet = rig({ tokenAtStart: "ee".repeat(32) });
    await quiet.cards.begin("m1", "a", "lantern");
    await quiet.cards.abandon("m1");
    expect(quiet.started[0].ended).toBe("immediate");
    expect(quiet.told).toEqual([]);
    expect(quiet.cards.slot).toBeNull();
    const told = rig({ tokenAtStart: "ee".repeat(32) });
    await told.cards.begin("m1", "a", "lantern");
    await told.cards.confirm("m1");
    told.told.length = 0;
    await told.cards.abandon("m1");
    expect(told.told).toEqual([{ card: null }]);
  });

  it("ends the card before it when another message goes out, and what a message that is no longer the card's says changes nothing", async () => {
    const { cards, started, told } = rig({ tokenAtStart: "ab".repeat(32) });
    await cards.begin("m1", "a", "one");
    await cards.begin("m2", "b", "two");
    expect(started[0].ended).toBe("immediate");
    expect(started[0].removed).toBe(1);
    expect(started[1].ended).toBeNull();
    expect(cards.slot).toBe("b");
    // The first message's answer comes late: its card is gone, so it is nothing to the Mac, and doesn't touch the second.
    await cards.confirm("m1");
    await cards.abandon("m1");
    expect(told).toEqual([]);
    expect(started[1].ended).toBeNull();
    started[0].gotToken("cd".repeat(32));
    await Promise.resolve();
    expect(told).toEqual([]);
  });

  it("starts one card for two sends in a row, not two: the first is ended before the second starts", async () => {
    const { cards, started } = rig();
    // Not waited for between them: a quick reply right after a send.
    const first = cards.begin("m1", "a", "lantern");
    const second = cards.begin("m2", "a", "lantern");
    await Promise.all([first, second]);
    expect(started).toHaveLength(2);
    expect(started[0].ended).toBe("immediate");
    expect(started[1].ended).toBeNull();
    expect(cards.slot).toBe("a");
  });

  it("clears the card, and tells the Mac there is none, when the chat it is for is opened; any other chat leaves it be", async () => {
    const { cards, started, told } = rig({ tokenAtStart: "ee".repeat(32) });
    await cards.begin("m1", "a", "lantern");
    await cards.confirm("m1");
    told.length = 0;
    await cards.opened("b");
    expect(started[0].ended).toBeNull();
    expect(told).toEqual([]);
    await cards.opened("a");
    expect(started[0].ended).toBe("immediate");
    expect(told).toEqual([{ card: null }]);
    expect(cards.slot).toBeNull();
    // Opening it again has nothing to clear.
    await cards.opened("a");
    expect(told).toHaveLength(1);
  });

  it("tells a Mac it connects to again of the card it has, and says nothing when there is none (the Mac keeps what it knew)", async () => {
    const { cards, told } = rig({ tokenAtStart: "ff".repeat(32) });
    await cards.connected();
    expect(told).toEqual([]);
    await cards.begin("m1", "a", "lantern");
    await cards.connected();
    expect(told).toEqual([]);
    await cards.confirm("m1");
    told.length = 0;
    await cards.connected();
    expect(told).toEqual([{ card: { slot: "a", token: "ff".repeat(32), project: "lantern", since: 5_000 } }]);
    // A card with no token yet has nothing to tell.
    const fresh = rig();
    await fresh.cards.begin("m1", "a", "lantern");
    await fresh.cards.confirm("m1");
    await fresh.cards.connected();
    expect(fresh.told).toEqual([]);
  });

  it("is no reason to fail a message when the card can't start, or the Mac can't be told", async () => {
    const off = rig({ startThrows: true });
    await expect(off.cards.begin("m1", "a", "lantern")).resolves.toBeUndefined();
    await expect(off.cards.confirm("m1")).resolves.toBeUndefined();
    expect(off.cards.slot).toBeNull();
    const offline = rig({ tokenAtStart: "ab".repeat(32), tellFails: true });
    await expect(offline.cards.begin("m1", "a", "lantern")).resolves.toBeUndefined();
    await expect(offline.cards.confirm("m1")).resolves.toBeUndefined();
    await expect(offline.cards.opened("a")).resolves.toBeUndefined();
  });

  it("does nothing where there is no Live Activity at all (Android, an older build)", async () => {
    const told: unknown[] = [];
    const cards = new LiveCards({ factory: () => null, tell: async (s) => void told.push(s) });
    await cards.begin("m1", "a", "lantern");
    await cards.confirm("m1");
    await cards.opened("a");
    await cards.connected();
    expect(told).toEqual([]);
    expect(cards.slot).toBeNull();
  });
});

describe("a tap on the card", () => {
  it("is a link to the chat, and only a link of that shape opens one", () => {
    expect(slotOfLink(chatLink("abc-123"))).toBe("abc-123");
    expect(slotOfLink(chatLink("chat 1/with slash"))).toBe("chat 1/with slash");
    expect(slotOfLink("LANTERN://chat/x")).toBe("x");
    expect(slotOfLink("lantern://chat/x/")).toBe("x");
    for (const other of ["lantern://pair?v=1", "lantern://chat/", "lantern://chat/a/b", "https://chat/a", "lantern://chat/%E0%A4%A", `lantern://chat/${"a".repeat(65)}`, "", null, undefined]) {
      expect(slotOfLink(other)).toBeNull();
    }
  });
});

describe("the summary card (a Mac that keeps one)", () => {
  const world = (over: Partial<World> = {}): World => ({ summary: true, connected: true, foreground: true, busy: true, ...over });
  let now = 5_000;
  function summaryRig(left: FakeCard[] = [], reply: () => unknown = () => ({ ended: false })) {
    const started: FakeCard[] = [];
    const told: { card: unknown }[] = [];
    const factory: CardFactory = {
      start: (props, url, stale) => {
        const card = new FakeCard(props, url, "ab".repeat(32), stale);
        started.push(card);
        return card;
      },
      getInstances: () => left,
    };
    const cards = new LiveCards({
      factory: () => factory,
      tell: async (s) => {
        told.push(s);
        return reply();
      },
      startTokens: () => null,
      now: () => now,
    });
    return { cards, started, told };
  }
  beforeEach(() => (now = 5_000));

  it("starts in front, connected, while a chat works, and hands the Mac its token as a summary", async () => {
    const { cards, started, told } = summaryRig();
    for (const w of [world({ busy: false }), world({ foreground: false }), world({ connected: false }), world({ summary: false })]) await cards.look(w);
    expect(started).toHaveLength(0);
    await cards.look(world());
    expect(started).toHaveLength(1);
    expect(started[0].props.chats).toEqual([]);
    expect(started[0].url).toBeUndefined();
    expect(told).toEqual([{ card: { slot: "", token: "ab".repeat(32), project: "Lantern", since: 5_000, summary: true } }]);
    // Looked at again while it is up: no second card.
    await cards.look(world());
    expect(started).toHaveLength(1);
  });

  it("is left to the Mac to end, and the next busy spell in front starts a new one", async () => {
    const { cards, started } = summaryRig();
    await cards.look(world());
    await cards.look(world({ busy: false }));
    expect(started[0].ended).toBeNull();
    // Busy again in the back: nothing can start yet.
    await cards.look(world({ foreground: false }));
    expect(started).toHaveLength(1);
    await cards.look(world());
    expect(started).toHaveLength(2);
    expect(started[0].ended).toBe("immediate");
  });

  it("is started afresh before iOS would end it", async () => {
    const { cards, started } = summaryRig();
    await cards.look(world());
    now += SUMMARY_RENEW_MS;
    await cards.look(world({ foreground: false }));
    await cards.look(world());
    expect(started).toHaveLength(2);
  });

  it("ends the cards the app's last run left, and starts its own", async () => {
    const left = [new FakeCard({ project: "Lantern", status: "working", since: 1 }, undefined, "cd".repeat(32)), new FakeCard({ project: "x", status: "done", since: 1 }, undefined)];
    const { cards, started, told } = summaryRig(left);
    await cards.look(world());
    expect(left.map((c) => c.ended)).toEqual(["immediate", "immediate"]);
    expect(started).toHaveLength(1);
    expect(told).toEqual([{ card: expect.objectContaining({ token: "ab".repeat(32), summary: true }) }]);
  });

  it("starts the next one when the Mac says it ended the last while the phone was away", async () => {
    let ended = false;
    const { cards, started } = summaryRig([], () => ({ ended }));
    await cards.look(world());
    // The chats went quiet with the phone in a pocket; then a new turn, and the app is opened again.
    ended = true;
    await cards.connected();
    await cards.look(world());
    expect(started).toHaveLength(2);
    expect(started[0].ended).toBe("immediate");
  });

  it("waits on a card an older answer says nothing about", async () => {
    const { cards, started } = summaryRig([], () => undefined);
    await cards.look(world());
    await cards.connected();
    await cards.look(world());
    expect(started).toHaveLength(1);
  });

  it("isn't ended by opening a chat, and a message sent starts no card of its own", async () => {
    const { cards, started, told } = summaryRig();
    await cards.look(world());
    await cards.begin("m1", "a", "lantern");
    await cards.opened("a");
    expect(started).toHaveLength(1);
    expect(started[0].ended).toBeNull();
    expect(told.filter((t) => t.card === null)).toHaveLength(0);
  });

  it("is told to the Mac again when the connection comes back", async () => {
    const { cards, told } = summaryRig();
    await cards.look(world());
    await cards.connected();
    expect(told).toHaveLength(2);
    expect(told[1]).toEqual(told[0]);
  });
});

describe("a card the Mac starts while the app is closed", () => {
  const START = "5a".repeat(40);
  function startRig(left: FakeCard[] = []) {
    const told: { card: unknown; start_token?: string }[] = [];
    let give: ((token: string) => void) | null = null;
    const started: FakeCard[] = [];
    const factory: CardFactory = {
      start: (props, url, stale) => {
        const card = new FakeCard(props, url, "ab".repeat(32), stale);
        started.push(card);
        return card;
      },
      getInstances: () => [...left, ...started],
    };
    const cards = new LiveCards({
      factory: () => factory,
      tell: async (s) => {
        told.push(s);
        return { ended: false };
      },
      startTokens: (listener) => {
        give = listener;
        return { remove: () => {} };
      },
      now: () => 5_000,
    });
    // Let what the constructor queued settle.
    const token = async (t: string) => {
      give?.(t);
      await cards.connected().catch(() => {});
    };
    return { cards, told, token, started, left };
  }

  it("hands the Mac the phone's token for starting a card as soon as iOS gives it, and on every connection, with no card to tell of", async () => {
    const { cards, told, token } = startRig();
    await token(START);
    expect(told[0]).toEqual({ card: null, start_token: START });
    told.length = 0;
    await cards.connected();
    expect(told).toEqual([{ card: null, start_token: START }]);
  });

  it("sends the start token with the card it tells of, and the card again with a new token", async () => {
    const { cards, told, token } = startRig();
    await token(START);
    await cards.look({ summary: true, connected: true, foreground: true, busy: true });
    expect(told.at(-1)).toEqual({ card: expect.objectContaining({ summary: true }), start_token: START });
    const NEW = "6b".repeat(40);
    await token(NEW);
    expect(told.some((t) => t.start_token === NEW && (t.card as { summary?: boolean } | null)?.summary === true)).toBe(true);
  });

  it("takes only what looks like Apple's token", async () => {
    const { told, token } = startRig();
    await token("not a token");
    await token("../../x");
    expect(told.every((t) => t.start_token === undefined)).toBe(true);
  });

  it("ends a card the Mac started (it is on the lock screen, not the app's own) when the app starts its own", async () => {
    const fromMac = new FakeCard({ project: "Lantern", status: "working", since: 1, chats: [], counts: { needs_you: 0, working: 1, done: 0, failed: 0 } }, undefined);
    const { cards, started } = startRig();
    // The app ran before the Mac's card came up (no launch to clear it): it is found when the app starts its own.
    await cards.look({ summary: true, connected: true, foreground: false, busy: true });
    expect(started).toHaveLength(0);
    started.push(fromMac);
    await cards.look({ summary: true, connected: true, foreground: true, busy: true });
    expect(fromMac.ended).toBe("immediate");
    expect(started.at(-1)?.ended).toBeNull();
  });
});
