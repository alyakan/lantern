/**
 * The notes Lantern sends the lead when its agents do something ("[Lantern: agent "Login form" (w1) finished its turn. Its
 * closing message, quoted (…): "…"]") are written for the model. In the chat they read as what happened, in plain words,
 * for the person watching. Chats saved before the rename say "worker" where these say "agent": both read.
 */

const secondsToWords = (secs: number) => (secs < 90 ? `${secs}s` : `${Math.round(secs / 60)} min`);
const AGENT = "(?:agent|worker)";

/** What a note says when it isn't one of these: nothing of the model's text, which is not for the person watching. */
export const UNKNOWN_NOTE = "Lantern passed an update to the lead.";

/** One note's inner text ("agent … finished …") as a sentence, or null when it isn't one Lantern writes. */
function friendly(inner: string): string | null {
  const at = (re: string, flags = "") => inner.match(new RegExp(re, flags));
  let m = at(`^${AGENT} "(.+?)" \\(\\w+\\) finished its turn( with an error)?\\. Its closing message, quoted \\([^)]*\\): "(.*)"$`, "s");
  if (m) return m[2] ? `${m[1]} hit an error: ${m[3]}` : `${m[1]} finished: ${m[3]}`;
  m = at(`^${AGENT} "(.+?)" \\(\\w+\\) stopped unexpectedly\\.$`);
  if (m) return `${m[1]} stopped unexpectedly`;
  m = at(`^${AGENT} "(.+?)" \\(\\w+\\) has been waiting on the user for (\\d+)s to allow \\(quoted\\): "(.*)"\\. Only the user can answer it\\.$`, "s");
  if (m) return `${m[1]} has been waiting for you for ${secondsToWords(Number(m[2]))}: ${m[3]}`;
  m = at(`^the user messaged ${AGENT} "(.+?)" \\(\\w+\\) directly\\. They wrote \\(quoted\\): "(.*)"$`, "s");
  if (m) return `You messaged ${m[1]}: ${m[2]}`;
  m = at(`^the user closed ${AGENT} "(.+?)" \\(\\w+\\) and (.+)\\.$`, "s");
  if (m) return `You closed ${m[1]}: ${m[2]}`;
  m = at(`^the user started ${AGENT} "(.+?)" \\(\\w+\\) themselves, (.+?); you didn't start it\\. Its task, in the user's words \\(quoted\\): "(.*)"$`, "s");
  if (m) return `You started ${m[1]} yourself: ${m[3]}`;
  m = at("^the user approved the merge: (.+) is now merged into (.+)\\.$");
  if (m) return `You approved the merge: ${m[1]} is now in ${m[2]}`;
  m = at("^the user approved merging (.+?), but it conflicts with the main checkout in these files \\(names, quoted\\): \"(.*)\"\\. Nothing was merged\\.", "s");
  if (m) return `Merging ${m[1]} hit conflicts in ${m[2]}; nothing was merged`;
  m = at("^the user approved merging (.+?), but it changed since you proposed it, so nothing was merged", "s");
  if (m) return `You approved merging ${m[1]}, but it had changed since it was proposed; nothing was merged`;
  m = at("^the user declined to merge (.+) for now\\.$");
  if (m) return `You declined to merge ${m[1]} for now`;
  return null;
}

/** Whether a message is made of Lantern's notes (and so is not something anyone typed). */
export function isNote(text: string): boolean {
  const paragraphs = text.trim().split(/\n\n+/);
  return paragraphs.length > 0 && paragraphs.every((p) => /^\[Lantern: .*\]$/s.test(p.trim()));
}

/** The notes in a message, one line each: what happened (an unfamiliar note is said as UNKNOWN_NOTE). A message that is not a note comes back as it is. */
export function friendlyNotes(text: string): string[] {
  if (!isNote(text)) return [text];
  return text
    .trim()
    .split(/\n\n+/)
    .map((p) => {
      const inner = p.trim().slice("[Lantern: ".length, -1);
      return friendly(inner) ?? UNKNOWN_NOTE;
    });
}
