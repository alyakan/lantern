import type { UiEvent } from "../types";
import { basename } from "./diff";

/**
 * A side chat's own state: the questions asked and the answers as they stream in. It is built only from a side chat's events
 * (see `AsideEvent`), which never go through a chat's reducer, so nothing here can reach a chat's messages, queue, permission
 * cards or totals.
 */

export interface AsideTurn {
  question: string;
  /** The answer's text blocks, in order (Claude may write some before it looks at a file and some after). */
  blocks: { id: string; text: string }[];
  /** What it is looking at now ("Reading retry.ts"), while it works. */
  step: string | null;
  status: "working" | "done" | "stopped" | "failed";
  /** Why it stopped or failed, in words for the user. */
  note: string | null;
}

export interface AsideState {
  turns: AsideTurn[];
  /** What this side chat has cost and used so far: its own, never added to the chat's. Null when not known. */
  cost: number | null;
  tokens: number;
  /** Whether it started from the chat's conversation (null until the first question went out). */
  forked: boolean | null;
  /** Its claude has gone: no more questions. */
  ended: boolean;
}

export type AsideAction =
  | { type: "asked"; question: string }
  | { type: "started"; forked: boolean }
  /** The question couldn't be sent (or the side chat couldn't start), with why. */
  | { type: "failed"; text: string }
  | { type: "event"; event?: UiEvent; note?: string };

export const emptyAside: AsideState = { turns: [], cost: null, tokens: 0, forked: null, ended: false };

export const answerOf = (turn: AsideTurn): string =>
  turn.blocks
    .map((b) => b.text.trim())
    .filter(Boolean)
    .join("\n\n");

/** What a side chat is doing, as a line under the answer: the tools it has are the ones that read. */
export function stepLine(name: string, summary: string): string {
  const what = summary.trim();
  if (name === "Read") return what ? `Reading ${basename(what)}` : "Reading a file";
  if (name === "Grep") return "Searching the files";
  if (name === "Glob") return "Looking for files";
  return "Working";
}

const last = (state: AsideState): AsideTurn | undefined => state.turns[state.turns.length - 1];

/** The last turn, changed (only while it is the one being answered unless `any`). */
function withLast(state: AsideState, change: (t: AsideTurn) => AsideTurn, any = false): AsideState {
  const turn = last(state);
  if (!turn || (!any && turn.status !== "working")) return state;
  return { ...state, turns: [...state.turns.slice(0, -1), change(turn)] };
}

const upsert = (blocks: AsideTurn["blocks"], id: string, change: (text: string) => string): AsideTurn["blocks"] =>
  blocks.some((b) => b.id === id) ? blocks.map((b) => (b.id === id ? { ...b, text: change(b.text) } : b)) : [...blocks, { id, text: change("") }];

export function asideReducer(state: AsideState, action: AsideAction): AsideState {
  switch (action.type) {
    case "asked":
      return { ...state, turns: [...state.turns, { question: action.question, blocks: [], step: null, status: "working", note: null }] };
    case "started":
      return state.forked === null ? { ...state, forked: action.forked } : state;
    case "failed":
      return withLast(state, (t) => ({ ...t, status: "failed", step: null, note: action.text }));
    case "event":
      return action.event ? onEvent(state, action.event) : action.note ? withLast(state, (t) => ({ ...t, status: "stopped", step: null, note: action.note! })) : state;
  }
}

function onEvent(state: AsideState, ev: UiEvent): AsideState {
  switch (ev.kind) {
    case "text_delta":
      return ev.parent ? state : withLast(state, (t) => ({ ...t, step: null, blocks: upsert(t.blocks, ev.block_id, (text) => text + ev.text) }));
    case "assistant_text":
      return ev.parent ? state : withLast(state, (t) => ({ ...t, step: null, blocks: upsert(t.blocks, ev.block_id, () => ev.text) }));
    case "tool_started":
      return ev.parent ? state : withLast(state, (t) => ({ ...t, step: stepLine(ev.name, ev.summary) }));
    case "retrying":
      return withLast(state, (t) => ({ ...t, step: "Trying again" }));
    case "turn_done": {
      // The totals are this claude's, which is only this side chat.
      const spent = { cost: ev.session_cost_usd ?? state.cost, tokens: ev.session_tokens ?? state.tokens };
      const text = ev.auth_hint ? "Claude isn't logged in. Run `claude /login` in a terminal." : (ev.result?.trim() || "That didn't work.");
      const done = withLast(state, (t) => (ev.is_error ? { ...t, status: "failed", step: null, note: text } : { ...t, status: "done", step: null }));
      return { ...done, ...spent };
    }
    case "session_ended":
      return { ...withLast(state, (t) => ({ ...t, status: "failed", step: null, note: "The side chat stopped unexpectedly. Close it and open a new one." })), ended: true };
    default:
      return state;
  }
}

/** Whether a question is being answered. */
export const isWorking = (state: AsideState): boolean => last(state)?.status === "working";
