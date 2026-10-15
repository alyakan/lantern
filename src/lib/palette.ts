/** One line of the command palette: an action, a mode, a models preset or a Settings page, with its shortcut if it has one. */
export interface PaletteEntry {
  id: string;
  title: string;
  group: string;
  shortcut: string | null;
  run: () => void;
}

/** Words that keep their capital in a sentence-case title. */
const PROPER = new Set(["Claude", "PR", "MCP", "Lantern"]);

/** "Switch Canvas and Chat View" → "Switch canvas and chat view": the palette's titles in sentence case, names kept. */
export function sentenceCase(title: string): string {
  return title
    .split(" ")
    .map((word, i) => {
      if (i === 0) return word;
      const bare = word.replace(/[…,.:]+$/, "");
      return PROPER.has(bare) || !/^[A-Z][a-z]*$/.test(bare) ? word : word[0].toLowerCase() + word.slice(1);
    })
    .join(" ");
}

/**
 * How well `query` matches `text`: every letter of the query, in order, somewhere in the text (case aside). A letter
 * that starts a word or follows the one before it scores more; a long gap scores less. Null when a letter isn't there.
 */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  const t = text.toLowerCase();
  let score = 0;
  let from = 0;
  let previous = -2;
  for (const letter of q) {
    const at = t.indexOf(letter, from);
    if (at < 0) return null;
    score += 1;
    if (at === previous + 1) score += 2;
    if (at === 0 || /[^a-z0-9]/.test(t[at - 1])) score += 3;
    score -= (at - from) * 0.1;
    previous = at;
    from = at + 1;
  }
  return score;
}

/** The entries that match `query`, best first (the order they came in, where scores are equal). Empty query: all of them. */
export function filterEntries(entries: PaletteEntry[], query: string): PaletteEntry[] {
  if (!query.trim()) return entries;
  return entries
    .map((entry, order) => ({ entry, order, score: fuzzyScore(query, entry.title) }))
    .filter((m): m is { entry: PaletteEntry; order: number; score: number } => m.score !== null)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((m) => m.entry);
}
