/**
 * A harness: which model does what in a chat. The main model and its effort, the advisor Claude consults at decision
 * points (--advisor), and the model subagents run on (CLAUDE_CODE_SUBAGENT_MODEL). Null = Claude Code's own setting.
 */
export interface Harness {
  id: string;
  name: string;
  model: string | null;
  effort: string | null;
  advisor: string | null;
  subagent: string | null;
}

export const DEFAULT_HARNESS = "default";
export const CUSTOM_HARNESS = "custom";

/** Standard runs as before (the app's model and effort, Claude Code's own advisor setting); the rest are presets. */
export const BUILT_IN: Harness[] = [
  { id: DEFAULT_HARNESS, name: "Standard", model: null, effort: null, advisor: null, subagent: null },
  { id: "balanced", name: "Balanced", model: "sonnet", effort: "high", advisor: "opus", subagent: "haiku" },
  { id: "thrifty", name: "Thrifty", model: "haiku", effort: "medium", advisor: "opus", subagent: "haiku" },
  { id: "max", name: "Max", model: "opus", effort: "high", advisor: "fable", subagent: "sonnet" },
];

export type Family = "haiku" | "sonnet" | "opus" | "fable";
export const FAMILIES: Family[] = ["opus", "sonnet", "haiku", "fable"];
export const FAMILY_LABEL: Record<Family, string> = { opus: "Opus", sonnet: "Sonnet", haiku: "Haiku", fable: "Fable" };

/** The family of a model alias or id ("sonnet", "claude-sonnet-5-5"); null when it can't be told. */
export function familyOf(model: string | null): Family | null {
  const m = model?.toLowerCase() ?? "";
  return FAMILIES.find((f) => m.includes(f)) ?? null;
}

/**
 * The advisors Claude Code accepts for a main model of this family, at the versions its aliases name today (Opus 5.5,
 * Sonnet 5.5, Haiku 5.5, Fable 5.1): an advisor ranks at or above the main model. See code.claude.com/docs/en/advisor.
 * Unknown main model: only the two that advise everything but Fable.
 */
export function advisorsFor(main: Family | null): Family[] {
  switch (main) {
    case "haiku":
      return ["opus", "sonnet", "haiku", "fable"];
    case "sonnet":
      return ["opus", "sonnet", "fable"];
    case "opus":
      return ["opus", "fable"];
    case "fable":
      return ["fable"];
    default:
      return ["opus", "fable"];
  }
}

/** Whether the harness's advisor suits its main model (`fallback`: what claude runs when the harness names none). */
export function validAdvisor(h: Harness, fallback: string | null): boolean {
  const a = familyOf(h.advisor);
  return h.advisor === null || (a !== null && advisorsFor(familyOf(h.model ?? fallback)).includes(a));
}

/** What a chat starts claude with: Default follows the app's model and effort and passes no harness flags. */
export function settingsOf(h: Harness, app: { model: string | null; effort: string | null }) {
  if (h.id === DEFAULT_HARNESS) return { model: app.model, effort: app.effort, advisor: null, subagent_model: null };
  return { model: h.model, effort: h.effort, advisor: h.advisor, subagent_model: h.subagent };
}

/** A model as people say it: "Sonnet" for "sonnet" or "claude-sonnet-5-5", else as given. */
export function modelName(m: string | null): string | null {
  const f = familyOf(m);
  return f ? FAMILY_LABEL[f] : m;
}
const name = modelName;

/** One line about what it does: "Sonnet · Opus advisor · Haiku subagents". */
export function summary(h: Harness): string {
  if (h.id === DEFAULT_HARNESS) return "Your model and effort, Claude Code's own settings";
  const parts = [name(h.model) ?? "Default model", h.advisor ? `${name(h.advisor)} advisor` : "no advisor", h.subagent ? `${name(h.subagent)} subagents` : null];
  return parts.filter(Boolean).join(" · ");
}

/** The presets to offer: Default first, then the saved ones (built-ins as edited, then your own). */
export function presetsOf(saved: Harness[]): Harness[] {
  return [BUILT_IN[0], ...saved.filter((h) => h.id !== DEFAULT_HARNESS)];
}

export const findHarness = (presets: Harness[], id: string | undefined | null) => presets.find((h) => h.id === id) ?? BUILT_IN[0];

/** Whether it uses Fable anywhere: on some plans that needs a one-time consent in Claude Code first. */
export const usesFable = (h: Harness) => [h.model, h.advisor, h.subagent].some((m) => familyOf(m) === "fable");
