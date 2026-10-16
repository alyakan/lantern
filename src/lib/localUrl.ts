import { cleanOutput } from "./shell";

const LOCAL_URL = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?![\w@-]|\.\w)(?::\d{1,5})?(?:\/[^\s"'<>`)\]]*)?(?=[.,;:!?]*\s)/i;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A web address only when it is this computer's own (localhost, 127.0.0.1 or ::1) over http or https: what a button may open from a program's output. */
export function localUrl(text: string): string | null {
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol) || !LOCAL_HOSTS.has(url.hostname) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** The first local address a program printed ("Local: http://localhost:5173/"), or null. Only one that ends in a space or a line break: output that stops in the middle of one is waiting for the rest. */
export function localUrlIn(output: string): string | null {
  const found = cleanOutput(output).match(LOCAL_URL);
  if (!found) return null;
  // A sentence's full stop or comma isn't part of the address.
  return localUrl(found[0].replace(/[.,;:!?]+$/, ""));
}
