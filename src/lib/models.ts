/** The models on offer. `null` is Claude Code's own default (whatever `claude` picks without `--model`). */
export const MODEL_CHOICES: { value: string | null; label: string; hint: string }[] = [
  { value: null, label: "Default", hint: "Claude Code's setting" },
  { value: "opus", label: "Opus", hint: "Most capable" },
  { value: "sonnet", label: "Sonnet", hint: "Fast and capable" },
  { value: "haiku", label: "Haiku", hint: "Fastest" },
];

/** What each alias resolves to today, until claude reports it itself (it names the model in every init message). */
export const KNOWN_IDS: Record<string, string> = {
  opus: "claude-opus-5-5",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-4-5-20251001",
};

/** The name a choice goes by in the picker: "Default (Opus 5.5)", "Sonnet 5.5". `ids` maps aliases to seen model ids. */
export function choiceName(value: string | null, defaultId: string | null, ids: Record<string, string> = {}): string {
  if (value === null) return defaultId ? `Default (${modelLabel(defaultId)})` : "Default";
  return modelLabel(ids[value] ?? KNOWN_IDS[value] ?? value);
}

/** "claude-opus-5-5" → "Opus 5.5", "claude-haiku-4-5-20251001" → "Haiku 4.5"; anything else is shown as is. */
export function modelLabel(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(\[.*\])?$/.exec(id);
  if (!m) return id;
  const [, family, major, minor, suffix] = m;
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ""}${suffix ? ` ${suffix}` : ""}`;
}
