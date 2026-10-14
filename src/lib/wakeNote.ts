/**
 * The notes Lantern sends the main agent when its workers do something ("[Lantern: worker "Login form" (w1) finished its
 * turn. Its closing message, quoted (…): "…"]") are written for the model. In the chat they read as what happened, in
 * plain words, for the person watching.
 */

const secondsToWords = (secs: number) => (secs < 90 ? `${secs}s` : `${Math.round(secs / 60)} min`);

/** One note's inner text ("worker … finished …") as a sentence, or null when it isn't one Lantern writes. */
function friendly(inner: string): string | null {
  let m = inner.match(/^worker "(.+?)" \(\w+\) finished its turn( with an error)?\. Its closing message, quoted \([^)]*\): "(.*)"$/s);
  if (m) return m[2] ? `${m[1]} hit an error: ${m[3]}` : `${m[1]} finished: ${m[3]}`;
  m = inner.match(/^worker "(.+?)" \(\w+\) stopped unexpectedly\.$/);
  if (m) return `${m[1]} stopped unexpectedly`;
  m = inner.match(/^worker "(.+?)" \(\w+\) has been waiting on the user for (\d+)s to allow \(quoted\): "(.*)"\. Only the user can answer it\.$/s);
  if (m) return `${m[1]} has been waiting for you for ${secondsToWords(Number(m[2]))}: ${m[3]}`;
  m = inner.match(/^the user messaged worker "(.+?)" \(\w+\) directly\. They wrote \(quoted\): "(.*)"$/s);
  if (m) return `You messaged ${m[1]}: ${m[2]}`;
  m = inner.match(/^the user approved the merge: (.+) is now merged into (.+)\.$/);
  if (m) return `You approved the merge: ${m[1]} is now in ${m[2]}`;
  m = inner.match(/^the user approved merging (.+?), but it conflicts with the main checkout in these files \(names, quoted\): "(.*)"\. Nothing was merged\./s);
  if (m) return `Merging ${m[1]} hit conflicts in ${m[2]}; nothing was merged`;
  m = inner.match(/^the user declined to merge (.+) for now\.$/);
  if (m) return `You declined to merge ${m[1]} for now`;
  return null;
}

/** Whether a message is made of Lantern's notes (and so is not something anyone typed). */
export function isNote(text: string): boolean {
  const paragraphs = text.trim().split(/\n\n+/);
  return paragraphs.length > 0 && paragraphs.every((p) => /^\[Lantern: .*\]$/s.test(p.trim()));
}

/** The notes in a message, one line each: what happened. A message that is not a note comes back as it is. */
export function friendlyNotes(text: string): string[] {
  if (!isNote(text)) return [text];
  return text
    .trim()
    .split(/\n\n+/)
    .map((p) => {
      const inner = p.trim().slice("[Lantern: ".length, -1);
      return friendly(inner) ?? inner;
    });
}
