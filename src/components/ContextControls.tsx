import { useEffect, useRef, useState } from "react";
import { useChatState, useChatStates, useNodeActions, useKnownWindows } from "../lib/canvasContext";
import { COMPACT_ALL_AT, contextShare, shortTokens, tidyBlock, type ContextShare } from "../lib/contextShare";
import type { OrchestraNode } from "../lib/orchestraView";
import { usePopover } from "../lib/usePopover";
import type { State } from "../store";
import { WARN_AT } from "./ContextMeter";
import { useMenuKeys } from "./useMenuKeys";

const COMPACT_HINT = "Summarise the conversation to free up context";
const CLEAR_HINT = "Start a fresh conversation (files stay as they are)";

/**
 * An agent's context share, on its title bar ("42%", amber from 75%, red from 90%, as the chat's own meter): a click opens
 * Compact and Clear for that agent. Both are messages to it, so they wait for the end of its turn; Clear throws the
 * conversation away, so it is asked about first, in the menu.
 */
export function NodeContext({ slot, name }: { slot: string; name: string }) {
  const state = useChatState(slot);
  const actions = useNodeActions();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const close = () => {
    setOpen(false);
    setConfirming(false);
  };
  const { box, button, id } = usePopover(open, close, false);
  const keys = useMenuKeys(open, box);
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) keep.current?.focus();
  }, [confirming]);
  const known = useKnownWindows();
  const share = contextShare(state, known);
  if (!state || !share) return null;
  const blocked = tidyBlock(state);
  const note = share.level === "full" ? ", nearly full" : share.level === "warn" ? ", getting full" : "";
  // A blocked item stays in the menu (aria-disabled, so it can be reached and its reason heard) and does nothing.
  const item = (label: string, hint: string, run: () => void, danger = false) => (
    <button role="menuitem" className={danger ? "danger" : undefined} aria-disabled={!!blocked} title={blocked ?? undefined} onClick={() => !blocked && run()}>
      <span className="menu-label">{label}</span>
      <span className="menu-hint">{blocked ?? hint}</span>
    </button>
  );

  return (
    <span className="node-context-anchor" ref={box}>
      <button
        ref={button}
        className={`node-context${share.level ? ` ${share.level}` : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={share.percent !== null ? `${name} context, ${share.percent}% used${note}` : `${name} context, ${share.used.toLocaleString()} tokens used, window not known yet`}
        title={share.percent !== null ? `${share.percent}% of ${name}'s context window is in use. Click to Compact or Clear it.` : `${share.used.toLocaleString()} tokens are in ${name}'s context. Its window isn't known until it finishes a turn. Click to Compact or Clear it.`}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {share.percent !== null ? `${share.percent}%` : shortTokens(share.used)}
      </button>
      {open && (
        <div id={id} className="canvas-menu canvas-overlay node-context-menu" role="menu" aria-label={`${name} context`} onKeyDown={keys.onKeyDown} onPointerDown={(e) => e.stopPropagation()}>
          {confirming ? (
            <>
              <p className="node-context-ask">{name} forgets this conversation. The files it changed stay as they are.</p>
              <button
                role="menuitem"
                className="danger"
                aria-disabled={!!blocked}
                onClick={() => {
                  if (blocked) return;
                  close();
                  actions.clear(slot);
                }}
              >
                <span className="menu-label">Clear it</span>
              </button>
              <button ref={keep} role="menuitem" onClick={() => setConfirming(false)}>
                <span className="menu-label">Keep it</span>
              </button>
            </>
          ) : (
            <>
              {item("Compact", COMPACT_HINT, () => {
                close();
                actions.send(slot, "/compact");
              })}
              {item("Clear", CLEAR_HINT, () => setConfirming(true), true)}
            </>
          )}
        </div>
      )}
    </span>
  );
}

interface Row extends ContextShare {
  node: OrchestraNode;
  state: State;
}

/**
 * The team's context, in the toolbar: how full the fullest agent's context is (the Lead's, until another is fuller),
 * saying whose when it isn't the Lead's. Warns in amber and red at the same points a chat's own meter does, in words as
 * well as colour. It opens a list of every agent with how full it is and Compact and Clear for each, and one button to
 * compact everyone over COMPACT_ALL_AT that is free to. A chat's context is what it holds now, so it drops when the agent
 * compacts.
 */
export function TeamContext({ nodes, onGoTo }: { nodes: OrchestraNode[]; onGoTo: (slot: string) => void }) {
  const states = useChatStates(nodes.map((n) => n.slot));
  const known = useKnownWindows();
  const actions = useNodeActions();
  const [open, setOpen] = useState(false);
  // The row asking whether to Clear, and what the last "Compact all" did.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const close = () => {
    setOpen(false);
    setConfirming(null);
    setSaid(null);
  };
  const { box, button, list, id } = usePopover(open, close);
  const rows: Row[] = nodes.flatMap((n, i) => {
    const share = contextShare(states[i], known);
    return share ? [{ node: n, state: states[i]!, ...share }] : [];
  });
  if (rows.length === 0) return null;
  // The fullest of those whose window is known (the first of equals: the Lead comes first); when none is known, the one holding the most tokens, said in tokens.
  const measured = rows.filter((r) => r.percent !== null);
  const fullest = measured.length > 0 ? measured.reduce((a, b) => ((b.percent ?? 0) > (a.percent ?? 0) ? b : a)) : rows.reduce((a, b) => (b.used > a.used ? b : a));
  const note = fullest.level === "full" ? "nearly full" : fullest.level === "warn" ? "getting full" : null;
  const whose = fullest.node.role === "main" ? "" : fullest.node.name;
  const advice = `At ${WARN_AT}% or more, open that agent and use Compact.`;
  const over = rows.filter((r) => r.percent !== null && r.percent > COMPACT_ALL_AT);
  const unknown = rows.length - measured.length;
  // What the chip says: the percent, or (window not known) the tokens.
  const shownFull = fullest.percent !== null ? `${fullest.percent}%` : shortTokens(fullest.used);
  const unknownNote = unknown > 0 && measured.length > 0 ? ` ${unknown === 1 ? "One agent's window isn't" : `${unknown} agents' windows aren't`} known yet, so it isn't counted.` : "";

  const compactAll = () => {
    const free = over.filter((r) => !tidyBlock(r.state));
    const skipped = over.length - free.length;
    for (const r of free) actions.send(r.node.slot, "/compact");
    const sent = free.length ? `Compacting ${free.length === 1 ? "1 agent" : `${free.length} agents`}.` : "";
    const left = skipped ? `Skipped ${skipped} that ${skipped === 1 ? "is" : "are"} busy.` : "";
    setSaid([sent, left].filter(Boolean).join(" "));
  };

  return (
    <div className="canvas-team" ref={box}>
      <button
        ref={button}
        className={`canvas-fit canvas-context${fullest.level ? ` ${fullest.level}` : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={fullest.percent !== null ? `Context: ${fullest.node.name} ${fullest.percent}% used${note ? `, ${note}` : ""}` : `Context: ${fullest.node.name} ${fullest.used.toLocaleString()} tokens used, window not known yet`}
        title={fullest.percent !== null ? `The share of ${fullest.node.name}'s context window in use now: the fullest agent's on the team. ${advice}${unknownNote} Click for every agent's.` : `${fullest.node.name}'s context holds ${fullest.used.toLocaleString()} tokens. A window isn't known until an agent finishes a turn, so there is no percent yet. Click for every agent's.`}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className="canvas-ctl-long">
          Context {shownFull}{whose && " · "}
          <span className="canvas-context-who">{whose}</span>
        </span>
        <span className="canvas-ctl-short">{shownFull}</span>
      </button>
      {open && (
        <div id={id} ref={list} className="canvas-team-list context-list" role="dialog" aria-label="Context by agent">
          <div className="ctx-head">
            <button
              className="ctx-all"
              aria-disabled={over.length === 0}
              title={over.length === 0 ? `No agent is above ${COMPACT_ALL_AT}%` : `Sends /compact to every agent above ${COMPACT_ALL_AT}% that has finished its turn`}
              onClick={() => over.length > 0 && compactAll()}
            >
              Compact all above {COMPACT_ALL_AT}%
            </button>
            <p className="ctx-said" role="status">
              {said}
            </p>
          </div>
          <div className="ctx-rows">
            {rows.map((r) => {
              const blocked = tidyBlock(r.state);
              const asking = confirming === r.node.slot;
              return (
                <div key={r.node.slot} className={`ctx-row${r.level ? ` ${r.level}` : ""}`}>
                  <button className="ctx-name" title={`Go to ${r.node.name}`} onClick={() => { close(); onGoTo(r.node.slot); }}>
                    {r.node.name}
                  </button>
                  <span className="ctx-percent">{r.percent !== null ? `${r.percent}%` : "window not known"}{r.level === "full" ? " · nearly full" : r.level === "warn" ? " · getting full" : ""}</span>
                  <div className="ctx-line">
                    {r.percent !== null ? (
                      <span className="ctx-bar" role="meter" aria-label={`${r.node.name} context used`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={r.percent}>
                        <span style={{ width: `${r.percent}%` }} />
                      </span>
                    ) : (
                      <span className="ctx-bar unknown" aria-hidden />
                    )}
                    <span className="ctx-tokens" title={r.window !== null ? `${r.used.toLocaleString()} of ${r.window.toLocaleString()} tokens` : `${r.used.toLocaleString()} tokens, window not known until a turn ends`}>
                      {r.window !== null ? `${shortTokens(r.used)} of ${shortTokens(r.window)}` : `${shortTokens(r.used)} used`}
                    </span>
                    {asking ? (
                      <span className="ctx-confirm">
                        <span>Clear it?</span>
                        <button
                          className="danger"
                          aria-label={`Yes, clear ${r.node.name}`}
                          onClick={() => {
                            setConfirming(null);
                            if (!tidyBlock(r.state)) actions.clear(r.node.slot);
                          }}
                        >
                          Clear
                        </button>
                        <button aria-label={`Keep ${r.node.name}'s conversation`} onClick={() => setConfirming(null)}>
                          Keep
                        </button>
                      </span>
                    ) : (
                      <span className="ctx-actions">
                        <button aria-label={`Compact ${r.node.name}`} aria-disabled={!!blocked} title={blocked ?? COMPACT_HINT} onClick={() => !blocked && actions.send(r.node.slot, "/compact")}>
                          Compact
                        </button>
                        <button aria-label={`Clear ${r.node.name}`} aria-disabled={!!blocked} title={blocked ?? CLEAR_HINT} onClick={() => !blocked && setConfirming(r.node.slot)}>
                          Clear
                        </button>
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
