/**
 * @jest-environment node
 *
 * The phone's real client (its Noise, Connection, WebSocket transport and Sync) against the real Rust gateway
 * (src-tauri/examples/fixture_gateway: the real Gateway and Wi-Fi transport behind three scripted chats). Nothing is
 * recorded or faked on either side. Runs when LANTERN_FIXTURE_GATEWAY names the built example, as CI does:
 *
 *   cargo build --manifest-path ../src-tauri/Cargo.toml --example fixture_gateway
 *   LANTERN_FIXTURE_GATEWAY=../src-tauri/target/debug/examples/fixture_gateway npm test -- integration
 *
 * Each test gets a fixture process of its own (it is quick to start), so what one answers is not gone for the next.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import { createInterface } from "readline";
import { Connection, macId, type ConnectionState } from "../net/connection";
import { webSocketTransport } from "../net/transport";
import { readPairingLink } from "../pairing";
import { MemoryStore } from "../test/memoryStore";
import { Sync } from "../sync/sync";
import { openPrompts } from "../sync/reducer";

const BIN = process.env.LANTERN_FIXTURE_GATEWAY;
const suite = BIN ? describe : describe.skip;
jest.setTimeout(30_000);

const RELEASE = "release";
const NETWORK = "network";
const PUSH = "perm-fixture-push";
const QUESTION = "perm-fixture-question";

interface Ready {
  port: number;
  link: string;
  macKey: string;
  secret: string;
}

/** The fixture process, and the lines of JSON it prints. */
function startFixture() {
  const proc: ChildProcessWithoutNullStreams = spawn(BIN!, ["--pace-ms", "10"]);
  const lines: Ready[] = [];
  const waiting: ((r: Ready) => void)[] = [];
  createInterface({ input: proc.stdout }).on("line", (l) => {
    const r = JSON.parse(l) as Ready;
    const w = waiting.shift();
    if (w) w(r);
    else lines.push(r);
  });
  const next = () => new Promise<Ready>((resolve) => (lines.length ? resolve(lines.shift()!) : waiting.push(resolve)));
  return {
    next,
    newCode: () => {
      proc.stdin.write("pair\n");
      return next();
    },
    stop: () => {
      proc.stdin.write("quit\n");
      proc.kill();
    },
  };
}

const until = async (what: string, cond: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

function makePhone(fixture: Ready, store = new MemoryStore()) {
  const sync = new Sync({ schedule: (fn) => queueMicrotask(fn) });
  const states: ConnectionState[] = [];
  let sessions = 0;
  const conn = new Connection({
    transport: webSocketTransport,
    store,
    // Bonjour's job: the fixture is on loopback.
    discovery: { find: async () => [{ host: "127.0.0.1", port: fixture.port, id: macId(fixture.macKey) }] },
    deviceName: "Jest phone",
    appVersion: "test",
    onPushed: sync.onPushed,
    onState: (s) => states.push(s),
    onSession: (s) => {
      sessions += 1;
      sync.onSession(s);
    },
    wait: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))),
  });
  const state = () => {
    sync.flush();
    return sync.getState();
  };
  return { sync, conn, store, states, state, sessions: () => sessions };
}

const offerOf = (f: Ready) => {
  const o = readPairingLink(f.link, Date.now());
  if ("error" in o) throw new Error(o.error);
  return { ...o, hosts: [] as string[] };
};

suite("the phone's client against the real gateway", () => {
  let fx: ReturnType<typeof startFixture>;
  let ready: Ready;
  beforeEach(async () => {
    fx = startFixture();
    ready = await fx.next();
  });
  afterEach(() => fx.stop());

  /** A phone paired with the fixture, with the chat list in. */
  async function paired() {
    const p = makePhone(ready);
    await p.conn.pair(offerOf(ready));
    await until("the chat list", () => p.state().chats.length === 3);
    return p;
  }

  it("pairs with the code, hears the chat list and what waits, and follows a chat from its start", async () => {
    const p = makePhone(ready);
    await p.conn.pair(offerOf(ready));
    expect(p.states.at(-1)).toMatchObject({ kind: "connected", welcome: { mac_name: "Fixture Mac" } });
    expect(p.store.mac?.macName).toBe("Fixture Mac");

    await until("the chat list", () => p.state().chats.length === 3);
    expect(Object.fromEntries(p.state().chats.map((c) => [c.slot, c.status]))).toEqual({ release: "needs_you", design: "working", network: "asleep" });
    expect(p.state().chats.find((c) => c.slot === RELEASE)).toMatchObject({ title: "Release 0.1.53", project: "lantern" });

    await until("what waits", () => p.state().waiting.length === 2);
    expect(p.state().waiting.map((w) => w.request_id)).toEqual([PUSH, QUESTION]);

    p.sync.follow(RELEASE);
    await until("the chat's start", () => (p.state().views[RELEASE]?.items.length ?? 0) > 0 && !p.state().views[RELEASE].resetting);
    const items = p.state().views[RELEASE].items;
    expect(items.find((i) => i.kind === "user")).toMatchObject({ text: "Cut 0.1.53 with the context menu fix, same flow as last time." });
    expect(items.some((i) => i.kind === "step" && i.edits.some((e) => e.path.endsWith("package.json") && e.added === 1 && e.removed === 1))).toBe(true);
    // The turn in progress came with it, once, and so did its two open prompts.
    expect(items.filter((i) => i.kind === "user" && i.text === "Go ahead and push it.")).toHaveLength(1);
    expect(openPrompts(p.state().views[RELEASE]).map((i) => i.id)).toEqual([PUSH, QUESTION]);
    p.conn.stop();
  });

  it("answers a command and a question from the phone, and the turn goes on", async () => {
    const p = await paired();
    p.sync.follow(RELEASE);
    await until("the prompts", () => openPrompts(p.state().views[RELEASE]).length === 2);

    await p.sync.answer(RELEASE, PUSH, true);
    await until("the command to be allowed", () => p.state().views[RELEASE].items.some((i) => i.kind === "prompt" && i.id === PUSH && i.state === "allowed"));
    const allowed = p.state().views[RELEASE].items.find((i) => i.kind === "prompt" && i.id === PUSH);
    expect(allowed).toMatchObject({ by: expect.stringMatching(/^phone-/) });
    await until("it to leave the stack", () => p.state().waiting.length === 1);

    // A prompt can't be answered twice, and the second says so.
    await expect(p.sync.answer(RELEASE, PUSH, false)).rejects.toThrow("answered already");

    await p.sync.answer(RELEASE, QUESTION, true, { "Which channel?": "Beta" });
    await until("Claude's reply", () => p.state().views[RELEASE].items.some((i) => i.kind === "assistant" && !i.streaming && i.text.includes("Beta")));
    await until("the turn's end", () => p.state().views[RELEASE].items.some((i) => i.kind === "turn"));
    expect(p.state().waiting).toEqual([]);
    p.conn.stop();
  });

  it("refuses answers to a question that aren't to its questions, and a tool's input it never sends", async () => {
    const p = await paired();
    await expect(p.sync.answer(RELEASE, QUESTION, true, { "Delete everything?": "yes" })).rejects.toThrow("aren't to this question");
    // Answers on a command are refused too: only a question has them.
    await expect(p.sync.answer(RELEASE, PUSH, true, { command: "rm -rf ~" })).rejects.toThrow("Only a question");
    await until("both still waiting", () => p.state().waiting.length === 2);
    p.conn.stop();
  });

  it("shows a message sent from the phone at once, and the Mac's copy replaces it", async () => {
    const p = await paired();
    p.sync.follow(RELEASE);
    await until("the chat", () => (p.state().views[RELEASE]?.items.length ?? 0) > 0);
    await p.sync.send(RELEASE, "ship it");
    await until("the Mac's copy", () => {
      const mine = p.state().views[RELEASE].items.filter((i) => i.kind === "user" && i.text === "ship it");
      return mine.length === 1 && mine[0].kind === "user" && !mine[0].sending && !!mine[0].sentBy?.startsWith("phone-");
    });
    await until("Claude's reply", () => p.state().views[RELEASE].items.some((i) => i.kind === "assistant" && !i.streaming && i.text === "You said: ship it"));
    await until("the turn's end", () => p.state().views[RELEASE].items.some((i) => i.kind === "turn" && i.id.includes("local-")));
    p.conn.stop();
  });

  it("says why a message to a chat that isn't open didn't go", async () => {
    const p = await paired();
    await p.sync.send("nope", "hello");
    await until("the failure", () => p.state().views.nope?.items.some((i) => i.kind === "user" && !!i.failed) ?? false);
    expect(p.state().views.nope.items[0]).toMatchObject({ failed: "That chat isn't open on your Mac." });
    p.conn.stop();
  });

  it("wakes a sleeping chat, and pages through a long one's history", async () => {
    const p = await paired();
    await p.sync.wake(NETWORK);
    await until("it to wake", () => p.state().chats.find((c) => c.slot === NETWORK)?.status === "idle");

    p.sync.follow(NETWORK);
    await until("its last turns", () => (p.state().views[NETWORK]?.items.filter((i) => i.kind === "user").length ?? 0) === 25 && !p.state().views[NETWORK].resetting);
    expect(p.state().views[NETWORK].hidden).toBe(5);
    await p.sync.loadEarlier(NETWORK);
    await until("the earlier turns", () => (p.state().views[NETWORK].items.filter((i) => i.kind === "user").length ?? 0) === 30);
    const first = p.state().views[NETWORK].items[0];
    expect(first).toMatchObject({ kind: "user", text: "Question 0" });
    expect(p.state().views[NETWORK].hidden).toBe(0);
    p.conn.stop();
  });

  it("reads a file's diff the chat changed, and nothing else", async () => {
    const p = await paired();
    await expect(p.sync.diff(RELEASE, "/Users/you/dev/lantern/package.json")).resolves.toContain("+  \"version\": \"0.1.53\"");
    await expect(p.sync.diff(RELEASE, "/etc/passwd")).rejects.toThrow("wasn't changed");
    p.conn.stop();
  });

  it("stops what Claude is doing, and the prompts it was waiting on go", async () => {
    const p = await paired();
    p.sync.follow(RELEASE);
    await until("the prompts", () => openPrompts(p.state().views[RELEASE]).length === 2);
    await p.sync.interrupt(RELEASE);
    await until("the prompts to close", () => openPrompts(p.state().views[RELEASE]).length === 0);
    await until("the stack to empty", () => p.state().waiting.length === 0);
    p.conn.stop();
  });

  it("comes back after the connection drops and carries on following the chat", async () => {
    const p = await paired();
    p.sync.follow(RELEASE);
    await until("the chat", () => (p.state().views[RELEASE]?.items.length ?? 0) > 0);
    const before = p.sessions();
    p.conn.current()!.close();
    await until("a new connection", () => p.sessions() === before + 1 && p.states.at(-1)?.kind === "connected");
    // It is subscribed again: what happens next arrives.
    await p.sync.send(RELEASE, "after the drop");
    await until("the reply", () => p.state().views[RELEASE].items.some((i) => i.kind === "assistant" && !i.streaming && i.text === "You said: after the drop"));
    p.conn.stop();
  });

  it("a phone the Mac doesn't know is turned away, and says to pair again", async () => {
    const p = await paired();
    const stranger = makePhone(ready);
    stranger.store.mac = { ...p.store.mac!, deviceKey: "A".repeat(43) };
    await stranger.conn.start();
    await until("it to give up", () => stranger.states.some((s) => s.kind === "offline"));
    expect(stranger.states.find((s) => s.kind === "offline")).toMatchObject({ reason: expect.stringMatching(/Pair it again|didn't answer/) });
    stranger.conn.stop();
    p.conn.stop();
  });

  it("a code works once: a second phone with the same code is turned away", async () => {
    const first = makePhone(ready);
    await first.conn.pair(offerOf(ready));
    const second = makePhone(ready);
    await expect(second.conn.pair(offerOf(ready))).rejects.toThrow("didn't take this code");
    expect(second.store.mac).toBeNull();
    first.conn.stop();
    // And a new code on the Mac pairs another phone.
    const again = await fx.newCode();
    const third = makePhone(again);
    await third.conn.pair(offerOf(again));
    expect(third.states.at(-1)?.kind).toBe("connected");
    third.conn.stop();
  });
});
