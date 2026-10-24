import { CLAUDE_CAPABILITIES } from "./lib/provider";
import type { ProviderInfo, ProviderListing } from "./types";

/** Two providers for tests: Claude Code with every capability, and one with none of its extras (no auto mode, advisor, skills or dollar cost). */
export const CLAUDE_INFO: ProviderInfo = { id: "claude", capabilities: CLAUDE_CAPABILITIES };
export const PLAIN: ProviderInfo = { id: "codex", capabilities: { supports_auto_mode: false, supports_advisor: false, reports_cost_usd: false, supports_skills: false, supports_effort: true, model_switchable: false, supports_lantern_tools: false, can_lead_team: false } };

export const CLAUDE_LISTING: ProviderListing = { ...CLAUDE_INFO, models: ["opus", "sonnet", "haiku"], binary: null };
export const PLAIN_LISTING: ProviderListing = { ...PLAIN, models: ["gpt-5-codex", "gpt-5", "o3"], binary: "/bin/codex" };
