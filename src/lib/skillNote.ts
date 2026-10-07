/**
 * Skills named in the middle of a message ("fix it, /systematic-debugging first") don't run as slash commands, which
 * only work at the start. A note before the message tells Claude to use them; reopening the chat takes it out again.
 */
const NOTE = /^\[Lantern: the user named skills in this message: ([^\]]*)\. Use them\.\]\s*/;

/** The skills named after the start of `text` (a leading "/command" is claude's to run, not a mention). */
export function skillsNamed(text: string, skills: Set<string>): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/(^|\s)\/([\w.:-]+)/g)) {
    if (m.index === 0 && m[1] === "") continue;
    if (skills.has(m[2]) && !found.includes(m[2])) found.push(m[2]);
  }
  return found;
}

export function withSkillNote(text: string, skills: Set<string>): string {
  if (text.startsWith("/")) return text;
  const named = skillsNamed(text, skills);
  return named.length ? `[Lantern: the user named skills in this message: ${named.map((s) => `/${s}`).join(", ")}. Use them.]\n\n${text}` : text;
}

export function readSkillNote(text: string): string {
  return text.replace(NOTE, "");
}
