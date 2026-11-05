/** Where a chat started from the compose button goes, worked out from what was said. Pure, so it is tested without a screen. */

export interface ProjectChoice {
  id: string;
  name: string;
}

/** The project a name in the words points at: one said whole, as words of their own ("in rayak", "the Lantern app"). */
function named(text: string, projects: ProjectChoice[]): ProjectChoice | null {
  const words = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  // The longest name first, so "lantern-mobile" wins over "lantern" when both are there.
  const byLength = [...projects].sort((a, b) => b.name.length - a.name.length);
  for (const p of byLength) {
    const name = p.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (name && words.includes(` ${name} `)) return p;
  }
  return null;
}

/**
 * The project to start in, and whether it was guessed from the words: a project named in them; else the one this phone last
 * started a chat in; else the Mac's first (the one used last there). Null when the Mac lists none.
 */
export function guessProject(text: string, projects: ProjectChoice[], last: string | null): { project: ProjectChoice; guessed: boolean } | null {
  const said = named(text, projects);
  if (said) return { project: said, guessed: true };
  const kept = projects.find((p) => p.id === last);
  if (kept) return { project: kept, guessed: false };
  return projects[0] ? { project: projects[0], guessed: false } : null;
}
