import vector from "./protocol/push-vector.json";
import { ensurePushKey, PUSH_KEY_BYTES, sharePushKey, toBase64, type PushKeyHost, type PushKeyStore } from "./pushKey";

const bytes = (n: number) => Uint8Array.from({ length: n }, (_, i) => i);

function memory(start: string | null = null) {
  let value = start;
  const store: PushKeyStore & { writes: number } = {
    writes: 0,
    read: async () => value,
    write: async (k) => {
      value = k;
      store.writes += 1;
    },
    forget: async () => {
      value = null;
    },
  };
  return store;
}

describe("the key for the words of notifications", () => {
  it("is standard base64 with padding, the same as the vector the Mac and the extension are checked against", () => {
    expect(toBase64(bytes(PUSH_KEY_BYTES))).toBe(vector.key_b64);
    expect(toBase64(Uint8Array.of(251, 255, 191))).toBe("+/+/");
    expect(toBase64(Uint8Array.of(1))).toBe("AQ==");
  });

  it("is made once, kept, and the same one comes back", async () => {
    const store = memory();
    const first = await ensurePushKey(store, bytes);
    expect(first).toBe(vector.key_b64);
    expect(await ensurePushKey(store, () => new Uint8Array(32).fill(9))).toBe(first);
    expect(store.writes).toBe(1);
  });

  it("is made again if what was kept is not a key", async () => {
    const store = memory("not a key");
    expect(await ensurePushKey(store, bytes)).toBe(vector.key_b64);
    expect(store.writes).toBe(1);
  });
});

describe("giving the Mac the key", () => {
  const host = (features: string[], fail = false) => {
    const sent: string[] = [];
    const h: PushKeyHost & { sent: string[] } = {
      sent,
      has: (f) => features.includes(f),
      registerPushKey: async (k) => {
        if (fail) throw new Error("The Mac said no");
        sent.push(k);
      },
    };
    return h;
  };

  it("sends it to a Mac that lists pushkey", async () => {
    const h = host(["pushkey"]);
    expect(await sharePushKey(h, memory(), bytes)).toBe(true);
    expect(h.sent).toEqual([vector.key_b64]);
  });

  it("sends nothing to a Mac that doesn't, or from a phone with no Keychain group to keep one in", async () => {
    const old = host(["liveactivity"]);
    expect(await sharePushKey(old, memory(), bytes)).toBe(false);
    expect(await sharePushKey(host(["pushkey"]), null, bytes)).toBe(false);
    expect(old.sent).toEqual([]);
  });

  it("is no trouble when the Keychain or the Mac says no: the notifications keep their short words", async () => {
    const broken: PushKeyStore = { read: async () => { throw new Error("no access group"); }, write: async () => {}, forget: async () => {} };
    expect(await sharePushKey(host(["pushkey"]), broken, bytes)).toBe(false);
    expect(await sharePushKey(host(["pushkey"], true), memory(), bytes)).toBe(false);
  });
});
