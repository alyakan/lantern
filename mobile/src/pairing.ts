/**
 * The link in the QR code a Mac shows for pairing (the Mac's pairing::pairing_link):
 * lantern://pair?v=1&k=<Mac's key>&s=<one-time secret>&h=<addresses>&p=<port>&n=<Mac's name>&e=<expires, ms>
 * Keys are URL-safe base64 without padding. Parsed by hand: React Native's URL has been partial (no searchParams) and the
 * format is fixed.
 */
import { fromBase64Url } from "./platform/utf8";

export { fromBase64Url, toBase64Url } from "./platform/utf8";

export interface PairingOffer {
  macKey: Uint8Array;
  secret: Uint8Array;
  /** The Mac's addresses on its networks, for when Bonjour finds nothing. */
  hosts: string[];
  port: number;
  macName: string;
  expiresAt: number;
}

/** An IPv4 address on a private network: the only kind the phone dials from a code. */
const privateIPv4 = (h: string) => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  if (m.slice(1).some((x) => Number(x) > 255)) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
};

const NOT_OURS = { error: "That isn't a Lantern pairing code." };

function query(link: string): Map<string, string> | null {
  const m = /^lantern:\/\/pair\/?\?(.*)$/i.exec(link.trim());
  if (!m) return null;
  const q = new Map<string, string>();
  for (const part of m[1].split("&")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    try {
      const key = decodeURIComponent(part.slice(0, eq));
      // The first of a repeated key counts, as a person reading the code would take it.
      if (!q.has(key)) q.set(key, decodeURIComponent(part.slice(eq + 1)));
    } catch {
      return null;
    }
  }
  return q;
}

/** The offer a scanned code carries, or why it isn't one (another app's code, a damaged one, one that expired). */
export function readPairingLink(link: string, now: number): PairingOffer | { error: string } {
  const q = query(link);
  if (!q) return NOT_OURS;
  if (q.get("v") !== "1") return { error: "That code is from a newer Lantern. Update this app." };
  try {
    const macKey = fromBase64Url(q.get("k") ?? "");
    const secret = fromBase64Url(q.get("s") ?? "");
    if (macKey.length !== 32 || secret.length !== 32) throw new Error();
    const port = Number(q.get("p"));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
    const expiresAt = Number(q.get("e"));
    if (!Number.isFinite(expiresAt)) throw new Error();
    if (now >= expiresAt) return { error: "That code has expired. Show a new one on your Mac." };
    const hosts = (q.get("h") ?? "").split(",").filter(privateIPv4);
    const macName = (q.get("n") ?? "").slice(0, 60) || "Mac";
    return { macKey, secret, hosts, port, macName, expiresAt };
  } catch {
    return { error: "That code is damaged. Show a new one on your Mac." };
  }
}
