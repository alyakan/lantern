import { EFFORT_HINT, effortLabel } from "../lib/effort";
import type { ModelOption } from "../types";
import { SettingsHint, SettingsRow } from "./SettingsRow";

export interface ProviderDefault {
  /** The provider's id, for the section's anchor. */
  id: string;
  /** What it is called: "Codex", an endpoint's own name. */
  agent: string;
  /** The models it takes (its own list: Claude's built-in one would be wrong for it). */
  options: ModelOption[];
  /** The model its new chats start on (null: the provider's own default). */
  chosen: string | null;
  onChoose: (model: string | null) => void;
  /** Thinking effort, when it takes one. */
  effort?: { chosen: string | null; levels: string[]; onChoose: (level: string | null) => void };
}

/**
 * Every provider but Claude Code, for Settings → Models: what that provider's new chats start on. This is the app's default for
 * the provider, not a chat's own choice — the Models chip under the box changes one chat; this changes where the next one starts.
 * The list doesn't change with the chat that happens to be open.
 */
export function ProviderDefaults({ providers }: { providers: ProviderDefault[] }) {
  return (
    <>
      {providers.map((p) => {
        // A model may take only some levels (or none): its own list wins, and the provider's is the stand-in until it says.
        const model = p.options.find((o) => o.value === p.chosen);
        const levels = model && model.effort_levels.length > 0 ? model.effort_levels : (p.effort?.levels ?? []);
        return (
          <section key={p.id} className="general-section" aria-labelledby={`provider-${p.id}`}>
            <h3 id={`provider-${p.id}`} className="general-title">
              {p.agent}
            </h3>
            <SettingsRow
              label="Model"
              control={
                <select aria-label={`${p.agent} model`} value={p.chosen ?? ""} onChange={(e) => p.onChoose(e.target.value || null)}>
                  <option value="">{p.agent}'s default</option>
                  {p.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.display_name}
                    </option>
                  ))}
                </select>
              }
              hint={`New chats on ${p.agent} start on this model.`}
            />
            {p.effort && (
              <SettingsRow
                label="Thinking effort"
                control={
                  <select aria-label={`${p.agent} thinking effort`} value={p.effort.chosen ?? ""} onChange={(e) => p.effort!.onChoose(e.target.value || null)}>
                    <option value="">{p.agent}'s default</option>
                    {levels.map((level) => (
                      <option key={level} value={level}>
                        {effortLabel(level)}
                      </option>
                    ))}
                  </select>
                }
                hint={EFFORT_HINT[p.effort.chosen ?? ""] ?? undefined}
              />
            )}
            {p.options.length === 0 && <SettingsHint>{p.agent} hasn't said which models it takes. It lists them when it starts.</SettingsHint>}
          </section>
        );
      })}
    </>
  );
}
