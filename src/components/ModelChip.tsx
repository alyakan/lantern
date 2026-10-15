import { familyOf, modelName } from "../lib/harness";

/** The model family an agent runs on, small: amber for Opus (the dear one), so one that drifts there shows at a glance. The tooltip is the full id. */
export function ModelChip({ model }: { model: string | null }) {
  const name = modelName(model);
  if (!model || !name) return null;
  return (
    <span className={`model-chip ${familyOf(model) ?? "other"}`} title={`Runs on ${model}`}>
      {name}
    </span>
  );
}
