/** Words for "Claude is working", in the spirit of Claude Code's spinner. */
export const WORKING_VERBS = [
  "Accomplishing", "Baking", "Brewing", "Calculating", "Cerebrating", "Churning", "Clauding", "Coalescing",
  "Cogitating", "Combobulating", "Computing", "Concocting", "Conjuring", "Considering", "Cooking", "Crafting",
  "Crunching", "Deliberating", "Discombobulating", "Finagling", "Forging", "Hatching", "Ideating", "Inferring",
  "Manifesting", "Marinating", "Moseying", "Mulling", "Musing", "Noodling", "Percolating", "Pondering",
  "Puttering", "Reticulating", "Ruminating", "Schlepping", "Simmering", "Smooshing", "Stewing", "Synthesizing",
  "Tinkering", "Transmuting", "Unfurling", "Vibing", "Whirring", "Wrangling",
];

/** One word per turn: the same `seed` (the turn's prompt id) always gets the same word, so it doesn't flicker. */
export function workingVerb(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return `${WORKING_VERBS[Math.abs(h) % WORKING_VERBS.length]}…`;
}
