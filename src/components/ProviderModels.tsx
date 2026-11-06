import { EFFORT_HINT, effortLabel } from "../lib/effort";
import type { ModelOption } from "../types";
import { SettingsHint, SettingsRow } from "./SettingsRow";

export interface ProviderModelsProps {
  /** What the chat's agent is called: "Codex", an endpoint's own name. */
  agent: string;
  /** The models it takes (its own list: Claude's built-in one would be wrong for it). */
  options: ModelOption[];
  /** The model chosen for the chat (null: the provider's own default). */
  chosen: string | null;
  onChoose: (model: string | null) => void;
  /** Thinking effort, when the provider takes one. */
  effort?: { chosen: string | null; levels: string[]; onChoose: (level: string | null) => void };
  /** No chat open: the choices are drawn, but not applied. */
  disabled?: boolean;
}

/**
 * Settings → Models for a chat that isn't Claude Code: the provider's own model, and its thinking effort when it has one.
 * Claude Code's presets (main model, advisor, subagents) are Claude's; a chat on Codex or an endpoint picks from what that
 * provider takes instead.
 */
export function ProviderModels({ agent, options, chosen, onChoose, effort, disabled = false }: ProviderModelsProps) {
  // A model may take only some levels (or none): its own list wins, and the provider's is the stand-in until it says.
  const model = options.find((o) => o.value === chosen);
  const levels = model && model.effort_levels.length > 0 ? model.effort_levels : (effort?.levels ?? []);
  return (
    <>
      <div className="settings-head">
        <div>
          <h2 className="mode-guide-title">Models</h2>
          <p className="mode-guide-summary">Which model {agent} runs on, and how hard it thinks. Claude Code's presets are Claude's; this chat runs on {agent}.</p>
        </div>
      </div>
      <section className="general-section" aria-labelledby="provider-model">
        <h3 id="provider-model" className="general-title">
          Model
        </h3>
        <SettingsRow
          label="Model"
          control={
            <select aria-label="Model" value={chosen ?? ""} disabled={disabled} onChange={(e) => onChoose(e.target.value || null)}>
              <option value="">{agent}'s default</option>
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.display_name}
                </option>
              ))}
            </select>
          }
          hint={disabled ? "Open a chat to change its model." : undefined}
        />
        {options.length === 0 && <SettingsHint>{agent} hasn't said which models it takes. It lists them when a chat starts.</SettingsHint>}
      </section>
      {effort && (
        <section className="general-section" aria-labelledby="provider-effort">
          <h3 id="provider-effort" className="general-title">
            Effort
          </h3>
          <SettingsRow
            label="Thinking effort"
            control={
              <select aria-label="Thinking effort" value={effort.chosen ?? ""} disabled={disabled} onChange={(e) => effort.onChoose(e.target.value || null)}>
                <option value="">{agent}'s default</option>
                {levels.map((level) => (
                  <option key={level} value={level}>
                    {effortLabel(level)}
                  </option>
                ))}
              </select>
            }
            hint={disabled ? "Open a chat to change how hard it thinks." : (EFFORT_HINT[effort.chosen ?? ""] ?? undefined)}
          />
        </section>
      )}
    </>
  );
}
