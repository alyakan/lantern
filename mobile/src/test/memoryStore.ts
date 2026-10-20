import type { MacStore, PairedMac } from "../net/connection";

/** A paired Mac kept in memory: the tests' stand-in for the Keychain or Keystore. */
export class MemoryStore implements MacStore {
  mac: PairedMac | null = null;
  async load() {
    return this.mac;
  }
  async save(m: PairedMac) {
    this.mac = m;
  }
  async forget() {
    this.mac = null;
  }
}
