/**
 * UTF-8 and base64url without TextEncoder, TextDecoder, atob or btoa: which of them a phone's JavaScript engine has
 * varies by React Native version, and the tests run on Node, which has them all. These depend on none.
 */

export function utf8Encode(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    // A surrogate pair is one code point; a lone surrogate is U+FFFD, as TextEncoder makes it.
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

/** Bytes as text; anything that isn't valid UTF-8 becomes U+FFFD, as TextDecoder does. */
export function utf8Decode(b: Uint8Array): string {
  let out = "";
  const chunk: number[] = [];
  const flush = () => {
    if (chunk.length) out += String.fromCharCode(...chunk.splice(0));
  };
  const push = (cp: number) => {
    if (cp >= 0x10000) {
      cp -= 0x10000;
      chunk.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else chunk.push(cp);
    if (chunk.length >= 4096) flush();
  };
  // As the WHATWG decoder does: the second byte's range depends on the first (so overlong forms, surrogates and values
  // past U+10FFFF never form), and a bad sequence is one U+FFFD for the bytes that were fine up to the bad one.
  for (let i = 0; i < b.length; ) {
    const c = b[i];
    if (c < 0x80) {
      push(c);
      i += 1;
      continue;
    }
    let need = 0;
    let lo = 0x80;
    let hi = 0xbf;
    if (c >= 0xc2 && c <= 0xdf) need = 1;
    else if (c >= 0xe0 && c <= 0xef) {
      need = 2;
      if (c === 0xe0) lo = 0xa0;
      if (c === 0xed) hi = 0x9f;
    } else if (c >= 0xf0 && c <= 0xf4) {
      need = 3;
      if (c === 0xf0) lo = 0x90;
      if (c === 0xf4) hi = 0x8f;
    } else {
      push(0xfffd);
      i += 1;
      continue;
    }
    let cp = c & (need === 1 ? 0x1f : need === 2 ? 0x0f : 0x07);
    let k = 1;
    for (; k <= need; k++) {
      const n = b[i + k];
      if (n === undefined || n < (k === 1 ? lo : 0x80) || n > (k === 1 ? hi : 0xbf)) break;
      cp = (cp << 6) | (n & 63);
    }
    if (k > need) {
      push(cp);
      i += need + 1;
    } else {
      push(0xfffd);
      i += k;
    }
  }
  flush();
  return out;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const REVERSE: Record<string, number> = Object.fromEntries([...ALPHABET].map((c, i) => [c, i]));

export function toBase64Url(b: Uint8Array): string {
  let out = "";
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += ALPHABET[(n >> 18) & 63] + ALPHABET[(n >> 12) & 63];
    if (i + 1 < b.length) out += ALPHABET[(n >> 6) & 63];
    if (i + 2 < b.length) out += ALPHABET[n & 63];
  }
  return out;
}

/** URL-safe base64 without padding; throws on anything else (including a length no encoding gives). */
export function fromBase64Url(s: string): Uint8Array {
  if (s.length % 4 === 1 || [...s].some((c) => !(c in REVERSE))) throw new Error("Not base64.");
  const out: number[] = [];
  for (let i = 0; i < s.length; i += 4) {
    const n = (REVERSE[s[i]] << 18) | (REVERSE[s[i + 1]] << 12) | ((REVERSE[s[i + 2]] ?? 0) << 6) | (REVERSE[s[i + 3]] ?? 0);
    out.push((n >> 16) & 255);
    if (i + 2 < s.length) out.push((n >> 8) & 255);
    if (i + 3 < s.length) out.push(n & 255);
  }
  return Uint8Array.from(out);
}
