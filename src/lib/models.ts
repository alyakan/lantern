import type { ModelOption } from "../types";

/** The models on offer. `null` is Claude Code's own default (whatever `claude` picks without `--model`). */
/**
 * What an agent of a team runs on unless its Lead named a model (WORKER_MODEL in orchestra.rs). A restored agent with no
 * model saved comes back on this, not on its project's own model: that is the Lead's, usually the dearest.
 */
export const AGENT_MODEL = "sonnet";

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

/** One choice in the model picker and the "+ Agent" form: `null` is the provider's own default. */
export type ModelChoice = (typeof MODEL_CHOICES)[number];

/**
 * The models on offer for a provider before it has listed its own (its `models` event): Claude's aliases, or Default and the
 * names the provider's CLI takes, which are shown as they are (see `modelLabel`). `agent` is what the provider is called.
 */
export function modelChoicesFor(providerId: string, models: string[], agent: string): ModelChoice[] {
  if (providerId === "claude") return MODEL_CHOICES;
  if (providerId.startsWith("gateway:")) return models.map((value) => ({ value, label: value, hint: "" }));
  return [{ value: null, label: "Default", hint: `${agent}'s setting` }, ...models.map((value) => ({ value, label: value, hint: "" }))];
}

/** Another provider's models as the model picker lists them, before its session reports its own: Default first, then each name its CLI takes. */
export function modelOptionsFor(models: string[], agent: string, noDefault = false): ModelOption[] {
  // An endpoint has no default of its own to start from: a chat on it is always on one of its models (the first, to begin with).
  if (noDefault) return models.map((value) => ({ value, resolved_model: value, display_name: value, description: "", effort_levels: [] }));
  return [{ value: "default", resolved_model: "", display_name: "Default", description: `${agent}'s setting`, effort_levels: [] }, ...models.map((value) => ({ value, resolved_model: value, display_name: value, description: "", effort_levels: [] }))];
}
