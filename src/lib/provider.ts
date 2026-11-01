import { createContext, useContext } from "react";
import type { Capabilities, Mode, ProviderInfo, ProviderListing } from "../types";

/**
 * The agent CLI behind a chat. Claude Code is the original and the default: a chat that doesn't say which provider it is on
 * (state saved before there was a choice, or one whose provider the backend hasn't told yet) is Claude's, with all it can do.
 */
export const CLAUDE = "claude";

export const CLAUDE_CAPABILITIES: Capabilities = {
  supports_auto_mode: true,
  supports_advisor: true,
  reports_cost_usd: true,
  supports_skills: true,
  supports_effort: true,
  model_switchable: true,
  supports_lantern_tools: true,
  can_lead_team: true,
  phone_approvals: true,
  supports_images: true,
  supports_compact: true,
  supports_clear: true,
};

/** What a provider can do; Claude's all of it when unknown. A flag a (newer or older) backend leaves out counts as Claude's too. */
export const capabilitiesOf = (p: ProviderInfo | null | undefined): Capabilities => (p ? { ...CLAUDE_CAPABILITIES, ...p.capabilities } : CLAUDE_CAPABILITIES);

export const providerIdOf = (p: ProviderInfo | null | undefined): string => p?.id ?? CLAUDE;

const NAMES: Record<string, string> = { claude: "Claude", codex: "Codex" };

/** An endpoint the user set up is a provider of its own, named "gateway:<its id>" (the backend's id for all of them is "gateway"). */
const GATEWAY = "gateway:";
export const isGateway = (id: string): boolean => id.startsWith(GATEWAY);

/** What the backend takes to start (or reopen) a chat on provider `id`: its `provider`, and for an endpoint which one. Claude's says nothing. */
export const wireProvider = (id: string): { provider?: string; endpoint?: string } => (isGateway(id) ? { provider: "gateway", endpoint: id.slice(GATEWAY.length) } : id === CLAUDE ? {} : { provider: id });

/** The names the user gave their endpoints, learned when the providers are listed: a chat's provider is known by its id alone. */
const endpointNames = new Map<string, string>();

/** What a provider is called on screen: "Claude", "Codex", an endpoint's own name; an id this build has no name for is capitalised. */
export const providerName = (id: string): string => {
  const own = NAMES[id] ?? endpointNames.get(id);
  if (own) return own;
  const bare = isGateway(id) ? id.slice(GATEWAY.length) : id;
  return `${bare.charAt(0).toUpperCase()}${bare.slice(1)}`;
};

/** The name for a chat's provider in copy ("Ask Codex…"); Claude when it isn't known. */
export const agentName = (p: ProviderInfo | null | undefined): string => providerName(providerIdOf(p));

/** Dollars are shown for a chat only when its provider reports them; it shows tokens otherwise (never $0.00, never an invented price). */
export const reportsUsd = (p: ProviderInfo | null | undefined): boolean => capabilitiesOf(p).reports_cost_usd;

/** The mode a provider can run: Auto only where it has an auto mode, else Ask (what the backend caps to as well). */
export const modeOn = (mode: Mode, caps: Capabilities): Mode => (mode === "auto" && !caps.supports_auto_mode ? "ask" : mode);

/** The providers offered, and where each is; only Claude when the backend hasn't said (or said none). */
export interface ProviderChoices {
  list: ProviderListing[];
  /** More than one: the controls that pick a provider, and the labels that say which one, appear only then. */
  multi: boolean;
}

export const ONLY_CLAUDE: ProviderChoices = { list: [], multi: false };

/**
 * The providers as the window keys them: each endpoint is its own, "gateway:<id>" (the backend lists them all as "gateway",
 * with the endpoint beside it). Learns their names on the way, for `providerName`.
 */
export const choicesOf = (list: ProviderListing[] | null): ProviderChoices => {
  const all = (list ?? []).map((l) => (l.endpoint ? { ...l, id: `${GATEWAY}${l.endpoint.id}` } : l));
  for (const l of all) if (l.endpoint) endpointNames.set(l.id, l.endpoint.name);
  return { list: all, multi: all.length > 1 };
};

/** What a team's agent can run on: the CLIs, not an endpoint the user set up (an agent on one comes with mixed teams). */
export const providerChoicesForAgents = (list: ProviderListing[]): ProviderListing[] => list.filter((l) => !l.endpoint);

export const ProvidersContext = createContext<ProviderChoices>(ONLY_CLAUDE);

/** Which providers the app has, for the labels and pickers that exist only with more than one. */
export const useProviders = () => useContext(ProvidersContext);
