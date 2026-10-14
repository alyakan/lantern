/** The home folder at the start of a path ("/Users/you" or "/home/you"), or null when the path isn't under one. */
export function homeOf(path: string): string | null {
  return /^\/(?:Users|home)\/[^/]+/.exec(path)?.[0] ?? null;
}

/** A path with its home folder written as "~" ("~/projects/acme-api"), as it reads in the app. */
export function tildePath(path: string): string {
  const home = homeOf(path);
  return home ? `~${path.slice(home.length)}` : path;
}

/**
 * A text cut to `max` characters with its middle replaced by "…", so both its start and its end stay readable
 * ("~/Documents/Github/…/acme-api"). Shorter texts come back as they are.
 */
export function middleTruncate(text: string, max = 56): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  const head = Math.ceil((max - 1) * 0.4);
  const tail = max - 1 - head;
  return `${chars.slice(0, head).join("")}…${chars.slice(chars.length - tail).join("")}`;
}
