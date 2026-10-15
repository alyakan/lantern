/**
 * Each project's colour in the sidebar. Picked to stay clear of the status colours (Claude's orange while it
 * works, amber when it needs you, blue when it finished unread), and readable as a tint and as a fill in both themes.
 */
export const PROJECT_COLORS = ["#5b5bd6", "#0f8a7e", "#c2255c", "#2b8a3e", "#9c36b5", "#0b7285", "#8d6e63", "#5c6b7a"];

const valid = (index: number | undefined): index is number => Number.isInteger(index) && index! >= 0 && index! < PROJECT_COLORS.length;

/**
 * The saved colours (folder → index into PROJECT_COLORS) with each folder in view given one. A new folder gets the
 * colour fewest of the projects in view have, then the one fewest saved projects have, then the first in the list, so
 * the projects on screen differ until there are more of them than colours. A saved colour never changes. Returns `saved`
 * itself when nothing was added.
 */
export function assignColors(folders: string[], saved: Record<string, number>): Record<string, number> {
  const fresh = folders.filter((f) => !valid(saved[f]));
  if (fresh.length === 0) return saved;
  const next: Record<string, number> = {};
  for (const [folder, index] of Object.entries(saved)) if (valid(index)) next[folder] = index;
  const inView = PROJECT_COLORS.map(() => 0);
  const overall = PROJECT_COLORS.map(() => 0);
  for (const f of folders) if (f in next) inView[next[f]]++;
  for (const index of Object.values(next)) overall[index]++;
  for (const folder of fresh) {
    let pick = 0;
    for (let i = 1; i < PROJECT_COLORS.length; i++) if (inView[i] < inView[pick] || (inView[i] === inView[pick] && overall[i] < overall[pick])) pick = i;
    next[folder] = pick;
    inView[pick]++;
    overall[pick]++;
  }
  return next;
}
