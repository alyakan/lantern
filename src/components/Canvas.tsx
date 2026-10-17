import { memo, useCallback, useContext, useEffect, useLayoutEffect, useReducer, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  bounds,
  centerOn,
  clampZoom,
  firstBox,
  fitView,
  GAP,
  moveBox,
  overlaps,
  panBy,
  inView,
  placeCheck,
  placeWorker,
  resizeBox,
  inSummary,
  SUMMARY_ZOOM,
  tether,
  zoomAt,
  type Box,
  type Size,
  type View,
} from "../lib/canvas";
import { ChatStoreContext, CloseAgentContext, useChatState, useChatStates, useNodeActions } from "../lib/canvasContext";
import { agreedOf, bulkEffect, closeAll, closedLine, planClosing, riskyQuestion, stoppedAgents, isStopped, type ClosePlan } from "../lib/closeStopped";
import { ProjectSetupContext, runCommandOf } from "../lib/projectSetup";
import { useAction } from "../lib/actions";
import { lostText, nodeStatus, readyToMerge, statusLabel, summaryLine, usage, type NodeStatus, type OrchestraNode } from "../lib/orchestraView";
import { usePopover } from "../lib/usePopover";
import { totalCost, totalTokens, type State } from "../store";
import { isBusy } from "../sessions";
import { permissionsOf, workflowOf } from "../lib/workflow";
import type { CloseAgreed, CloseCheck } from "../types";
import type { AgentRole } from "../lib/roles";
import { AgentMenu, type AgentMenuItem } from "./AgentMenu";
import { ConfirmDialog } from "./ConfirmDialog";
import { HiddenAgents } from "./HiddenAgents";
import { NewAgent } from "./NewAgent";
import { ModelChip } from "./ModelChip";
import { NodeBody } from "./NodeBody";
import { BranchIcon, ChevronIcon, OpenOutIcon, PlayIcon } from "./icons";
import { PermissionsMenu, WorkflowMenu } from "./ModeMenu";
import { SubagentsMenu } from "./SubagentsMenu";
import { ReviewMenu } from "./ReviewMenu";
import { reviewBusy, reviewStrip } from "../lib/reviewChain";
import { CanvasOverflow } from "./CanvasOverflow";
import { longSpan, quietFor, shortSpan, useQuiet } from "../lib/quiet";
import { useQuietAfter } from "../lib/quietSetting";
import { NodeContext, TeamContext } from "./ContextControls";

/** Where agents sit and how the canvas is framed. The app keeps it, so leaving the canvas and coming back finds it as it was. */
export interface CanvasLayout {
  boxes: Record<string, Box>;
  view: View | null;
  /** The user has moved the view themselves, so new agents no longer re-frame it. */
  touched: boolean;
  /** Agents folded to their title bar. */
  collapsed: Record<string, boolean>;
  /** Agents back to front. */
  order: string[];
  /** Agents already drawn on the canvas: one not in here is new, and arrives. */
  seen: Set<string>;
  /** Agents hidden when the canvas was last laid out: a hidden agent takes no room, so one that comes back may need a new place. */
  hidden: Set<string>;
}

export const newLayout = (): CanvasLayout => ({ boxes: {}, view: null, touched: false, collapsed: {}, order: [], seen: new Set(), hidden: new Set() });

/**
 * Gives every agent a place (new ones go below their main agent, in free space) and forgets agents that are gone. Hidden agents
 * take no room, so a new agent goes where it would if they weren't there; one that is shown again keeps its place unless
 * something else has taken it, and then moves to free space.
 */
export function placeNodes(layout: CanvasLayout, nodes: { slot: string; role: "main" | "worker"; parent: string | null; reviewOf?: string; hidden?: boolean }[]): void {
  const live = new Set(nodes.map((n) => n.slot));
  for (const slot of Object.keys(layout.boxes)) if (!live.has(slot)) delete layout.boxes[slot];
  const hidden = new Set(nodes.filter((n) => n.hidden).map((n) => n.slot));
  const taken = (except?: string) => Object.entries(layout.boxes).filter(([slot]) => slot !== except && !hidden.has(slot)).map(([, box]) => box);
  for (const n of nodes) {
    const was = layout.hidden.has(n.slot);
    if (layout.boxes[n.slot] && !(was && !n.hidden && taken(n.slot).some((b) => overlaps(layout.boxes[n.slot], b)))) continue;
    const all = taken(n.slot);
    delete layout.boxes[n.slot];
    // An agent that checks a builder's work goes beside that builder; any other below its main agent, in the nearest free spot.
    const builder = n.reviewOf ? layout.boxes[n.reviewOf] : undefined;
    const parent = n.parent ? layout.boxes[n.parent] : undefined;
    if (n.role === "worker" && (builder || parent)) {
      layout.boxes[n.slot] = builder ? placeCheck(all, builder, parent) : placeWorker(all, parent!);
    } else {
      // A main agent (or a worker whose main agent is gone) goes below whatever is already there.
      const b = bounds(all);
      layout.boxes[n.slot] = b ? { ...firstBox(), x: b.x, y: b.y + b.h + GAP * 2 } : firstBox();
    }
  }
  layout.hidden = hidden;
  layout.order = [...layout.order.filter((s) => live.has(s)), ...nodes.map((n) => n.slot).filter((s) => !layout.order.includes(s))];
}

/** A folded agent shows its title bar only. */
const COLLAPSED_HEIGHT = 52;
/** Zoomed out into cards, a title bar is drawn at a size that reads on screen (see `.canvas.summary .node-head`), so a folded card is that tall in the canvas's own units. */
const SUMMARY_HEAD = 40;
const foldedHeight = (summary: boolean, zoom: number) => (summary ? SUMMARY_HEAD / zoom : COLLAPSED_HEIGHT);
/** Room the agent menu needs, so one opened near an edge is moved in. */
const MENU_SIZE = { w: 270, h: 120 };
const errText = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : "That didn't work.");

interface Props {
  nodes: OrchestraNode[];
  layout: CanvasLayout;
  /** The agent whose chat the rest of the app treats as current. */
  activeSlot: string;
  /** Agents waiting on the user, in canvas order. */
  attention: string[];
  onFocus: (slot: string) => void;
  /** Shows one agent full size, in the chat view. */
  onOpen: (slot: string) => void;
}

interface FrameProps {
  slot: string;
  /** The main agent a worker reports to. */
  parent: string | null;
  role: "main" | "worker";
  name: string;
  branch: string | null;
  /** The role it was started in, and whether it can only read (its role says so, or it works in your own folder). */
  agentRole?: AgentRole;
  readOnly: boolean;
  box: Box;
  z: number;
  focused: boolean;
  /** Zoomed out too far to read a chat: a card with the agent's latest words instead. */
  summary: boolean;
  collapsed: boolean;
  /** It was not on the canvas before: it fades and grows in. */
  fresh: boolean;
  /** A Lead whose team still has agents: it stays in Team until they are closed. */
  holdsAgents: boolean;
  onGrab: (e: ReactPointerEvent<HTMLElement>, slot: string, kind: "move" | "resize") => void;
  onDrag: (e: ReactPointerEvent<HTMLElement>) => void;
  onRelease: (e: ReactPointerEvent<HTMLElement>) => void;
  onToggle: (slot: string) => void;
  onOpen: (slot: string) => void;
  onPress: (slot: string) => void;
  /** The right button was pressed on a worker's card. */
  onMenu: (e: ReactMouseEvent<HTMLElement>, slot: string) => void;
  /** Its "more" button was pressed: the same menu, from the button. */
  onMore: (e: ReactMouseEvent<HTMLElement>, slot: string) => void;
}

/** The agent's latest words and state, for the card that stands in for its chat when zoomed out or folded. */
function SummaryBody({ slot, strip }: { slot: string; strip: string | null }) {
  const state = useChatState(slot);
  const quiet = useQuiet(state?.activityAt ?? null, !!state && nodeStatus(state) === "working", useQuietAfter());
  if (!state) return null;
  const open = state.proposals.filter((p) => p.status === "open").length;
  return (
    <div className="node-summary">
      <p className="node-summary-line">{summaryLine(state, 220)}</p>
      {strip && <p className="node-summary-note">{strip}</p>}
      {quiet?.stuck && <p className="node-summary-note node-summary-quiet">Quiet for {longSpan(quiet.ms)}. It may be stuck.</p>}
      {open > 0 && <p className="node-summary-note">{open === 1 ? "A merge is waiting for you" : `${open} merges are waiting for you`}</p>}
    </div>
  );
}

const Frame = memo(function Frame({ slot, parent, role, name, branch, agentRole, readOnly, box, z, focused, summary, collapsed, fresh, holdsAgents, onGrab, onDrag, onRelease, onToggle, onOpen, onPress, onMenu, onMore }: FrameProps) {
  const state = useChatState(slot);
  const owner = useChatState(parent ?? slot);
  const status: NodeStatus = state ? nodeStatus(state) : "ended";
  const folded = collapsed;
  // A worker whose branch the main agent has asked the user to merge: that is what it is waiting on, and it's theirs to answer.
  const ready = !!parent && !!owner?.proposals.some((p) => p.worker === slot && p.status === "open");
  // Lantern's review and test of this agent's work, while it runs and after: a small strip under its title.
  const review = parent ? owner?.reviews.find((r) => r.builder === slot) : undefined;
  const strip = reviewStrip(review);
  // A card at work that's been quiet a while says how long, so a long think can be told from a stuck one; from three minutes
  // on it turns amber and says what to do, since the agent may be stuck.
  const quiet = useQuiet(state?.activityAt ?? null, status === "working", useQuietAfter());
  const stuck = !!quiet?.stuck;
  const label = stuck ? `Quiet ${quiet.span}` : state?.setup ? (state.setup.status === "failed" ? "Setup stopped" : "Setting up") : statusLabel(status, role, ready);
  // The project's Run command (saved in its setup), for a card whose agent has started.
  const setups = useContext(ProjectSetupContext);
  const runCommand = runCommandOf(setups, role === "main" ? state?.folder : owner?.folder);
  const spent = state ? usage(totalCost(state), totalTokens(state)) : "";
  const actions = useNodeActions();
  return (
    <section
      className={`canvas-node ${role} ${status}${stuck ? " stuck" : ""}${ready ? " ready" : ""}${focused ? " focused" : ""}${folded ? " folded" : ""}${fresh ? " enter" : ""}`}
      data-node={slot}
      aria-label={`${role === "main" ? name : `Agent ${name}`}, ${label}`}
      style={{ transform: `translate(${box.x}px, ${box.y}px)`, width: box.w, height: folded ? (summary ? `calc(${SUMMARY_HEAD}px / var(--zoom))` : COLLAPSED_HEIGHT) : box.h, zIndex: z }}
      onPointerDownCapture={() => onPress(slot)}
      onContextMenu={role === "worker" ? (e) => onMenu(e, slot) : undefined}
    >
      <header
        className="node-head"
        tabIndex={0}
        onPointerDown={(e) => onGrab(e, slot, "move")}
        onPointerMove={onDrag}
        onPointerUp={onRelease}
        onPointerCancel={onRelease}
        onDoubleClick={() => onToggle(slot)}
        onKeyDown={(e) => {
          // Enter on the title bar itself (not on a button in it) opens the agent full size.
          if (e.key === "Enter" && e.target === e.currentTarget) onOpen(slot);
        }}
      >
        <span className={`node-dot ${status}${stuck ? " stuck" : ""}`} aria-hidden />
        <span className="node-titles">
          <span className="node-name" title={name}>
            {name}
          </span>
          <span className="node-meta">
            <ModelChip model={state?.model ?? null} />
            {branch && <BranchIcon />}
            {/* The model chip stays whole; this is what gives way when the card is narrow, and the tooltip has all of it. */}
            <span className="node-meta-text" title={[role === "main" ? "Runs the team" : (branch ?? "Shared folder"), spent || null].filter(Boolean).join(" · ")}>
              {[role === "main" ? "Runs the team" : branch ? branch.replace(/^lantern\//, "") : "Shared folder", spent || null].filter(Boolean).join(" · ")}
            </span>
          </span>
        </span>
        {state && !folded && <NodeContext slot={slot} name={name} />}
        {/* Both settings are on every window's title bar, so a team's Permissions can be changed from the canvas. */}
        {state && !folded && (
          <span className="node-settings">
            <PermissionsMenu compact permissions={permissionsOf(state)} onChange={(p) => actions.setPermissions(slot, p)} disabled={isBusy(state)} />
            <WorkflowMenu compact workflow={workflowOf(state)} agent={role === "worker"} holdsAgents={holdsAgents} onChange={(w) => actions.setWorkflow(slot, w)} disabled={isBusy(state)} />
          </span>
        )}
        <span className="node-status" title={stuck ? `No word from it for ${longSpan(quiet.ms)}. It may be stuck.` : quiet ? `Its last step was ${quiet.span} ago` : undefined}>
          {label}
          {quiet && !stuck && <span className="node-quiet"> · {quiet.span} ago</span>}
        </span>
        {runCommand && state?.folder && !state.setup && !folded && (
          <button className="icon node-run" aria-label={`Run ${name}`} title={state.run?.status === "running" ? "It is running: see below" : `Run: ${runCommand}`} disabled={state.run?.status === "running"} onClick={() => actions.run(slot)}>
            <PlayIcon />
          </button>
        )}
        {role === "worker" && (
          <button className="icon" aria-label={`More for ${name}`} aria-haspopup="menu" title="More: hide, or clean up and close" onClick={(e) => onMore(e, slot)}>
            ⋯
          </button>
        )}
        <button className="icon" aria-label={folded ? `Expand ${name}` : `Collapse ${name}`} title={folded ? "Expand" : "Collapse to its title"} onClick={() => onToggle(slot)}>
          <ChevronIcon up={!folded} />
        </button>
        <button className="icon" aria-label={`Open ${name} full size`} title="Open full size" onClick={() => onOpen(slot)}>
          <OpenOutIcon />
        </button>
      </header>
      {!folded && (agentRole || readOnly) && (
        <div className="node-role-bar">
          {agentRole && <span className="role-chip">{agentRole.label}</span>}
          {readOnly && (
            <span className="role-chip read-only" title="It can read files, search and list them and run read-only git: it cannot change files or run other commands">
              Read only
            </span>
          )}
        </div>
      )}
      {!folded && strip && (
        <div className={`node-review${reviewBusy(review) ? " busy" : ""}`} title="Lantern had this work reviewed and tested by itself. The Lead has the reports; nothing was merged or changed.">
          <span className="node-review-dot" aria-hidden />
          {strip}
        </div>
      )}
      {!folded && (
        <div key={summary ? "card" : "chat"} className="node-body" title={summary ? "Click to zoom in on this agent" : undefined}>
          {summary ? <SummaryBody slot={slot} strip={strip} /> : <NodeBody slot={slot} parent={parent} />}
        </div>
      )}
      {!folded && <div className="node-resize" aria-hidden onPointerDown={(e) => onGrab(e, slot, "resize")} onPointerMove={onDrag} onPointerUp={onRelease} onPointerCancel={onRelease} />}
    </section>
  );
});

/** A tether from a main agent to one of its workers: it flows while the worker works, and pulses when it needs you. */
const TetherLine = memo(function TetherLine({ slot, d, fresh }: { slot: string; d: string; fresh: boolean }) {
  const state = useChatState(slot);
  const status: NodeStatus = state ? nodeStatus(state) : "ended";
  // The fade is on a group of its own: the line's own animation (flowing, pulsing) is its status's.
  return (
    <g className={fresh ? "tether-enter" : undefined}>
      <path className={`tether ${status}`} data-tether={slot} d={d} />
    </g>
  );
});

/**
 * Everyone on the team at a glance: who is doing what, what each has said last, and what the team has cost so far. A row
 * takes you to that agent. The team's cost counts every agent, however far off the canvas it is.
 */
/** What "Ask for an update" asks the main agent: a status report a person can read without knowing the code. */
export const UPDATE_REQUEST =
  "Give me a short status report in plain language: for each agent, what it has done, what it is doing now, and anything blocked or waiting for my decision. Look at each agent's latest work first if you need to. No code unless I ask.";

function Team({ nodes, onGoTo, onCloseStopped }: { nodes: OrchestraNode[]; onGoTo: (slot: string) => void; onCloseStopped: () => void }) {
  const [open, setOpen] = useState(false);
  const actions = useNodeActions();
  const states = useChatStates(nodes.map((n) => n.slot));
  const bySlot: Record<string, State> = {};
  nodes.forEach((n, i) => {
    if (states[i]) bySlot[n.slot] = states[i]!;
  });
  const ready = readyToMerge(nodes, bySlot);
  // Who has gone quiet, which no stream event says: the list looks again every few seconds.
  const quietAfter = useQuietAfter();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);
  const quietMs: Record<string, number> = {};
  for (const n of nodes) {
    const ms = bySlot[n.slot] ? quietFor(bySlot[n.slot], now, quietAfter) : null;
    if (ms !== null) quietMs[n.slot] = ms;
  }
  const quietCount = Object.keys(quietMs).length;
  const all = Object.values(bySlot);
  const total = usage(
    all.reduce((sum, s) => sum + totalCost(s), 0),
    all.reduce((sum, s) => sum + totalTokens(s), 0),
  );
  const main = nodes.find((n) => n.role === "main");
  const mainState = main ? bySlot[main.slot] : undefined;
  const stopped = stoppedAgents(nodes, (slot) => bySlot[slot]).length;
  const canAsk = !!main && !!mainState && (mainState.status === "idle" || mainState.status === "running") && nodes.some((n) => n.role === "worker");
  // Sent now when the main agent is free, and queued behind what it is doing when it isn't (like anything typed to it).
  const askForUpdate = () => {
    if (!main || !mainState) return;
    if (mainState.status === "running") actions.queue(main.slot, [...mainState.queued, UPDATE_REQUEST]);
    else actions.send(main.slot, UPDATE_REQUEST);
    setOpen(false);
    onGoTo(main.slot);
  };

  // Closes when you click anywhere else or press Escape (which puts focus back on the button).
  const { box, button, list, id } = usePopover(open, () => setOpen(false));

  return (
    <div className="canvas-team" ref={box}>
      <button ref={button} className="canvas-fit" aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? id : undefined} aria-label="Team" title="Everyone on the team, and what it has cost" onClick={() => setOpen(!open)}>
        Team{total && <span className="canvas-ctl-long"> · {total}</span>}
        {quietCount > 0 && <span className="team-quiet"> · {quietCount} quiet</span>}
      </button>
      {open && (
        <div id={id} ref={list} className="canvas-team-list" role="dialog" aria-label="Team">
          <ul>
            {nodes.map((n) => {
              const s = bySlot[n.slot];
              if (!s) return null;
              const status = nodeStatus(s);
              const quiet = n.slot in quietMs;
              const label = quiet ? `Quiet ${shortSpan(quietMs[n.slot])}` : statusLabel(status, n.role, ready.has(n.slot));
              const spent = usage(totalCost(s), totalTokens(s));
              return (
                <li key={n.slot}>
                  <button
                    onClick={() => {
                      setOpen(false);
                      onGoTo(n.slot);
                    }}
                  >
                    <span className={`node-dot ${status}${quiet ? " stuck" : ""}`} aria-hidden />
                    <span className="team-text">
                      <span className="team-name">
                        {n.name} <ModelChip model={s.model} />
                      </span>
                      <span className="team-line">{summaryLine(s, 90)}</span>
                    </span>
                    <span className={`team-state${quiet ? " quiet" : ""}`}>
                      {label}
                      {spent && <span className="team-cost">{spent}</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {stopped > 0 && (
            <button
              className="team-ask"
              onClick={() => {
                setOpen(false);
                onCloseStopped();
              }}
              title="Closes the agents that have stopped, and removes their worktrees and branches. You are asked about any with work that isn't merged."
            >
              Close stopped agents ({stopped})
            </button>
          )}
          {canAsk && (
            <button className="team-ask" onClick={askForUpdate} title="The Lead writes up where everything stands, in plain language">
              Ask the Lead for an update
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Controls({ zoom, attention, nodes, onZoom, onFit, onNext, onGoTo, onShow, onCloseStopped, main }: { zoom: number; attention: number; nodes: OrchestraNode[]; onZoom: (factor: number) => void; onFit: () => void; onNext: () => void; onGoTo: (slot: string) => void; onShow: (slot: string) => void; onCloseStopped: () => void; main: string | undefined }) {
  // One ring each time the count goes up (not when the canvas opens with some waiting already).
  const before = useRef(attention);
  const [rung, setRung] = useState(0);
  useEffect(() => {
    if (attention > before.current) setRung((n) => n + 1);
    before.current = attention;
  }, [attention]);
  const full = attention === 1 ? "1 agent needs you" : `${attention} agents need you`;
  return (
    <div className="canvas-controls" role="group" aria-label="Canvas view">
      {/* Part of the toolbar, so it never sits on an agent's title bar. The wording shortens with the canvas's width, like the toolbar's other chips. */}
      {attention > 0 && (
        <button className="canvas-attention" onClick={onNext} aria-label={full} title="Go to the next agent waiting for you">
          {rung > 0 && <span key={rung} className="canvas-attention-ring" aria-hidden />}
          <span className="node-dot waiting" aria-hidden />
          <span className="canvas-attn-long" aria-hidden>{full}</span>
          <span className="canvas-attn-mid" aria-hidden>{attention === 1 ? "1 needs you" : `${attention} need you`}</span>
          <span className="canvas-attn-short" aria-hidden>{attention}</span>
        </button>
      )}
      <button className="icon" aria-label="Zoom out" title="Zoom out" onClick={() => onZoom(1 / 1.25)}>
        −
      </button>
      <span className="canvas-zoom" aria-live="off">
        {Math.round(zoom * 100)}%
      </span>
      <button className="icon" aria-label="Zoom in" title="Zoom in" onClick={() => onZoom(1.25)}>
        +
      </button>
      <button className="canvas-fit" aria-label="Fit everything" title="Fit everything in view" onClick={onFit}>
        Fit
      </button>
      <TeamContext nodes={nodes} onGoTo={onGoTo} />
      <Team nodes={nodes} onGoTo={onGoTo} onCloseStopped={onCloseStopped} />
      {/* Below a width the rest fold into "⋯" (the canvas's container query decides which shows). */}
      <div className="canvas-ctl-wide">
        <HiddenAgents nodes={nodes.filter((n) => n.hidden)} onShow={onShow} />
        {main && <SubagentsMenu main={main} />}
        {main && <ReviewMenu main={main} />}
        {main && <NewAgent main={main} />}
      </div>
      {main && <CanvasOverflow main={main} hidden={nodes.filter((n) => n.hidden)} onShow={onShow} />}
    </div>
  );
}

/**
 * One visually hidden live region for the whole canvas: it says when an agent starts needing you (a prompt, or a lead whose
 * updates are held) and when a merge arrives, since a card's colour is all a screen reader's user would otherwise miss.
 * Nothing is said for what was already waiting when the canvas opened.
 */
function Announcer({ nodes }: { nodes: OrchestraNode[] }) {
  const states = useChatStates(nodes.map((n) => n.slot));
  const seen = useRef<Set<string> | null>(null);
  const [said, setSaid] = useState("");
  const now = new Map<string, string>();
  nodes.forEach((n, i) => {
    const s = states[i];
    if (!s) return;
    const status = nodeStatus(s);
    if (status === "waiting") now.set(`${n.slot}:waiting`, `${n.name} needs you.`);
    if (status === "held") now.set(`${n.slot}:held`, `${n.name} needs you: its updates are held.`);
  });
  states.forEach((s) => {
    for (const p of s?.proposals ?? []) if (p.status === "open") now.set(`${p.worker}:merge:${p.branch}`, `A merge of ${p.name} is ready for you.`);
  });
  const key = [...now.keys()].join("|");
  useEffect(() => {
    const before = seen.current;
    seen.current = new Set(now.keys());
    if (!before) return;
    const fresh = [...now].filter(([k]) => !before.has(k)).map(([, text]) => text);
    if (fresh.length) setSaid(fresh.join(" "));
    // `now` is rebuilt every render; its keys are what changes.
  }, [key]);
  return (
    <div className="sr-only" role="status" aria-live="polite">
      {said}
    </div>
  );
}

const sameSize = (a: Size, b: Size) => a.w === b.w && a.h === b.h;

/**
 * The orchestra's canvas: each agent a floating chat, tethered to the main agent it works for. Drag a title to move one,
 * its corner to resize it, the background to pan, pinch or ⌘-scroll to zoom. Gestures are painted straight onto the
 * elements and only committed to React when they end, so nothing redraws a chat while you move around.
 */
export function Canvas({ nodes, layout, activeSlot, attention, onFocus, onOpen }: Props) {
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const viewport = useRef<HTMLDivElement>(null);
  const world = useRef<HTMLDivElement>(null);
  const size = useRef<Size>({ w: 0, h: 0 });
  const view = useRef<View>(layout.view ?? { x: 0, y: 0, zoom: 1 });
  const paintTethersRef = useRef<() => void>(() => {});
  const [zoomPct, setZoomPct] = useState(view.current.zoom);
  const [summary, setSummary] = useState(view.current.zoom < SUMMARY_ZOOM);
  const summaryRef = useRef(summary);
  const nextAttention = useRef(0);
  const actions = useNodeActions();
  const store = useContext(ChatStoreContext);
  // Cards that arrived off screen on a canvas the user has framed themselves: it doesn't re-frame, so the corner says they are there.
  const [unseen, setUnseen] = useState<string[]>([]);
  const unseenRef = useRef<string[]>([]);
  const refreshUnseen = useCallback(() => {
    if (unseenRef.current.length === 0) return;
    const next = unseenRef.current.filter((slot) => layout.boxes[slot] && !inView(view.current, size.current, layout.boxes[slot]));
    if (next.length === unseenRef.current.length) return;
    unseenRef.current = next;
    setUnseen(next);
  }, [layout]);

  // Hidden agents keep their place (so one comes back where it was) but are not drawn, tethered or framed.
  placeNodes(layout, nodes);
  const visible = nodes.filter((n) => !n.hidden);
  // Agents not on the canvas before this render arrive with a little motion; they are marked as drawn once it has been.
  const arriving = new Set(visible.map((n) => n.slot).filter((s) => !layout.seen.has(s)));
  useEffect(() => {
    for (const n of visible) layout.seen.add(n.slot);
  });
  const shownSlots = useRef<string[]>([]);
  shownSlots.current = visible.map((n) => n.slot);

  // The world keeps a layer of its own only while it moves (smooth panning and zooming); a moment after it stops, the layer
  // is let go and the text is drawn again at the zoom it is at. Held, the layer keeps the picture it had at the zoom it
  // was first drawn and scales that, which is what made text soft when zoomed in.
  const settle = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(settle.current), []);

  /** Frames the canvas at `v`: straight onto the elements (no React), animated when it's a jump rather than a gesture. */
  const apply = useCallback((v: View, animate = false) => {
    view.current = v;
    layout.view = v;
    const w = world.current;
    const vp = viewport.current;
    if (w) {
      w.classList.add("moving");
      window.clearTimeout(settle.current);
      settle.current = window.setTimeout(() => w.classList.remove("moving"), animate ? 360 : 160);
      w.classList.toggle("animating", animate);
      w.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`;
      if (animate) window.setTimeout(() => w.classList.remove("animating"), 320);
    }
    if (vp) {
      vp.style.setProperty("--zoom", String(v.zoom));
      vp.style.setProperty("--vx", `${v.x}px`);
      vp.style.setProperty("--vy", `${v.y}px`);
    }
    // Cards below SUMMARY_ENTER, chats again above SUMMARY_EXIT; in between, whichever it was.
    summaryRef.current = inSummary(summaryRef.current, v.zoom);
    refreshUnseen();
    // A folded card's height depends on the zoom once it is a card, and its tether meets it.
    if (Object.values(layout.collapsed).some(Boolean)) paintTethersRef.current();
    // Only these two things in React depend on the zoom: the label, and whether agents are cards. Both are cheap.
    setSummary(summaryRef.current);
    setZoomPct((prev) => (Math.round(prev * 100) === Math.round(v.zoom * 100) ? prev : v.zoom));
  }, [layout, refreshUnseen]);

  const fit = useCallback((animate: boolean) => {
    const boxes = shownSlots.current.map((s) => layout.boxes[s]).filter(Boolean);
    // Not while a gesture is in hand: re-framing under a pointer would move what it is moving.
    if (size.current.w === 0 || boxes.length === 0 || drag.current || pan.current) return;
    apply(fitView(boxes, size.current), animate);
  }, [apply, layout]);

  // Track the canvas's size; the first time it is known (and whenever the user hasn't framed it themselves), frame the agents.
  useLayoutEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const measure = () => {
      const next = { w: el.clientWidth, h: el.clientHeight };
      if (sameSize(size.current, next)) return;
      const first = size.current.w === 0;
      size.current = next;
      if (first && !layout.view) fit(false);
      else if (first) apply(layout.view!, false);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [apply, fit, layout]);

  // A new agent appears: until the user has framed the canvas, bring everyone into view.
  const slotKey = visible.map((n) => n.slot).join(",");
  useEffect(() => {
    if (!layout.touched) fit(true);
  }, [slotKey, fit, layout]);

  // A new card on a canvas the user has framed: not re-framed, but a card that is off screen is pointed out.
  useEffect(() => {
    const slots = new Set(shownSlots.current);
    const fresh = [...arriving].filter((slot) => slots.has(slot) && layout.boxes[slot]);
    const kept = unseenRef.current.filter((slot) => slots.has(slot));
    const off = layout.touched && size.current.w > 0 ? fresh.filter((slot) => !inView(view.current, size.current, layout.boxes[slot])) : [];
    const next = [...new Set([...kept, ...off])];
    if (next.length === unseenRef.current.length && next.every((s, i) => s === unseenRef.current[i])) return;
    unseenRef.current = next;
    setUnseen(next);
  }, [slotKey]);

  const touch = () => {
    layout.touched = true;
  };

  // Wheel and pinch. Native listeners, because React's wheel handlers can't cancel the page's own zoom.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const rect = el.getBoundingClientRect();
      const at = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        touch();
        apply(zoomAt(view.current, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.004)), at));
        return;
      }
      // Over an agent's chat, its merge cards or composer, or a list or form that floats over the canvas, the wheel scrolls
      // that; anywhere else (a card, a title, the background) it pans.
      if ((e.target as Element).closest(".node-chat, .node-merges, .node-composer, .canvas-team-list, .canvas-overlay")) return;
      e.preventDefault();
      touch();
      apply(panBy(view.current, -e.deltaX, -e.deltaY));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    // WebKit (the app's web view) sends a pinch as gesture events rather than ctrl+wheel.
    let last = 1;
    const at = (e: Event) => {
      const rect = el.getBoundingClientRect();
      const g = e as Event & { clientX: number; clientY: number };
      return { x: g.clientX - rect.left, y: g.clientY - rect.top };
    };
    const onGestureStart = (e: Event) => {
      e.preventDefault();
      last = 1;
    };
    const onGestureChange = (e: Event) => {
      e.preventDefault();
      const scale = (e as Event & { scale: number }).scale;
      touch();
      apply(zoomAt(view.current, scale / last, at(e)));
      last = scale;
    };
    el.addEventListener("gesturestart", onGestureStart);
    el.addEventListener("gesturechange", onGestureChange);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("gesturestart", onGestureStart);
      el.removeEventListener("gesturechange", onGestureChange);
    };
  }, [apply, layout]);

  // Panning: drag the background, or (zoomed out, where cards cover most of it) a card. A press on a card that doesn't move
  // is a click, which zooms in on it. Pointer capture would send that click to the canvas, so the pan keeps hold of the
  // pointer itself (it is on the canvas element, which sees every move).
  const pan = useRef<{ id: number; x: number; y: number; from: number; fromY: number; moved: boolean; card: string | null } | null>(null);
  const onBackgroundDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    const onBackground = t === e.currentTarget || t.classList.contains("canvas-world") || !!t.closest("svg.canvas-tethers");
    const card = summary && !onBackground && !t.closest("button") ? (t.closest("[data-node]") as HTMLElement | null)?.dataset.node ?? null : null;
    // A control-click is a right-click on a Mac: it opens a menu, it doesn't start a pan.
    if (e.button !== 0 || e.ctrlKey || !(onBackground || (card && t.closest(".node-body")))) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pan.current = { id: e.pointerId, x: e.clientX, y: e.clientY, from: e.clientX, fromY: e.clientY, moved: false, card: card && t.closest(".node-body") ? card : null };
  };
  const onBackgroundMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = pan.current;
    if (!p || p.id !== e.pointerId) return;
    // A few pixels of wobble in a click is not a pan: the view stays framed as it was, and the click still counts.
    if (!p.moved && Math.hypot(e.clientX - p.from, e.clientY - p.fromY) < 4) return;
    if (!p.moved) {
      p.moved = true;
      layout.touched = true;
      e.currentTarget.classList.add("panning");
    }
    apply(panBy(view.current, e.clientX - p.x, e.clientY - p.y));
    p.x = e.clientX;
    p.y = e.clientY;
  };
  const onBackgroundUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = pan.current;
    if (p?.id !== e.pointerId) return;
    pan.current = null;
    e.currentTarget.classList.remove("panning");
    if (!p.moved && p.card && e.type === "pointerup") goTo(p.card);
  };

  // Moving and resizing agents: painted onto the elements each frame, committed when released.
  const drag = useRef<{ id: number; kind: "move" | "resize"; slot: string; x: number; y: number; box: Box; zoom: number } | null>(null);
  /** An agent as the canvas shows it: a folded one is only its title bar tall, and its tether meets that. */
  const shown = (slot: string, zoom = view.current.zoom): Box => {
    const b = layout.boxes[slot];
    return layout.collapsed[slot] ? { ...b, h: foldedHeight(summaryRef.current, zoom) } : b;
  };
  const frame = useRef(0);
  const nodesNow = useRef(nodes);
  nodesNow.current = nodes;
  /** Redraws every tether from where the agents are now (a folded card's height depends on the zoom when zoomed out). */
  const paintTethers = useCallback(() => {
    const w = world.current;
    if (!w) return;
    const zoom = view.current.zoom;
    for (const n of nodesNow.current) {
      const line = n.parent && layout.boxes[n.parent] && layout.boxes[n.slot] ? w.querySelector(`[data-tether="${n.slot}"]`) : null;
      if (!line) continue;
      const at = (slot: string): Box => (layout.collapsed[slot] ? { ...layout.boxes[slot], h: foldedHeight(summaryRef.current, zoom) } : layout.boxes[slot]);
      line.setAttribute("d", tether(at(n.parent!), at(n.slot)).d);
    }
  }, [layout]);
  paintTethersRef.current = paintTethers;
  const paint = useCallback(() => {
    frame.current = 0;
    const w = world.current;
    if (!w) return;
    for (const n of nodes) {
      const box = layout.boxes[n.slot];
      const el = w.querySelector<HTMLElement>(`[data-node="${n.slot}"]`);
      if (!box || !el) continue;
      el.style.transform = `translate(${box.x}px, ${box.y}px)`;
      el.style.width = `${box.w}px`;
      if (!layout.collapsed[n.slot]) el.style.height = `${box.h}px`;
    }
    paintTethers();
  }, [layout, nodes, paintTethers]);

  const bringToFront = useCallback((slot: string) => {
    if (layout.order[layout.order.length - 1] === slot) return;
    layout.order = [...layout.order.filter((s) => s !== slot), slot];
    redraw();
  }, [layout]);

  const onPress = useCallback((slot: string) => {
    onFocus(slot);
    bringToFront(slot);
  }, [onFocus, bringToFront]);

  const onGrab = useCallback((e: ReactPointerEvent<HTMLElement>, slot: string, kind: "move" | "resize") => {
    // A control-click is a right-click on a Mac: it opens the menu, it doesn't pick the card up.
    if (e.button !== 0 || e.ctrlKey || (e.target as Element).closest("button")) return;
    // No text selection while dragging.
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    // The zoom is taken now and kept for the whole drag: the movement is measured from here, in screen pixels, so a zoom
    // that changes meanwhile (a wheel tick, an agent arriving and the view re-framing) must not change what they mean.
    // A card's height eases when it folds; while it is being dragged to a size it must follow the pointer.
    if (kind === "resize") viewport.current?.classList.add("resizing");
    drag.current = { id: e.pointerId, kind, slot, x: e.clientX, y: e.clientY, box: { ...layout.boxes[slot] }, zoom: view.current.zoom };
  }, [layout]);

  const onDrag = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    layout.boxes[d.slot] = d.kind === "move" ? moveBox(d.box, dx, dy, d.zoom) : resizeBox(d.box, dx, dy, d.zoom);
    if (!frame.current) frame.current = requestAnimationFrame(paint);
  }, [layout, paint]);

  const onRelease = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    viewport.current?.classList.remove("resizing");
    if (frame.current) cancelAnimationFrame(frame.current);
    paint();
    redraw();
  }, [paint]);

  const onToggle = useCallback((slot: string) => {
    layout.collapsed[slot] = !layout.collapsed[slot];
    redraw();
  }, [layout]);

  // The menu of a worker's card (right-click), placed where it was opened.
  const [menu, setMenu] = useState<{ slot: string; x: number; y: number } | null>(null);
  const openMenuAt = useCallback((slot: string, from: { left: number; top: number }) => {
    const at = viewport.current?.getBoundingClientRect();
    if (!at) return;
    const room = (at: number, edge: number, size: number) => (size > 0 ? Math.max(8, Math.min(at, size - edge)) : at);
    setMenu({ slot, x: room(from.left - at.left, MENU_SIZE.w, size.current.w), y: room(from.top - at.top, MENU_SIZE.h, size.current.h) });
  }, []);
  const onMenu = useCallback((e: ReactMouseEvent<HTMLElement>, slot: string) => {
    // The box where the user types, and text they have picked, keep the browser's own menu (copy, paste).
    if ((e.target as Element).closest("textarea, input") || window.getSelection()?.toString()) return;
    e.preventDefault();
    // From the keyboard (the menu key) there is no pointer: it opens at the card's corner.
    openMenuAt(slot, e.clientX === 0 && e.clientY === 0 ? e.currentTarget.getBoundingClientRect() : { left: e.clientX, top: e.clientY });
  }, [openMenuAt]);
  // The "more" button: the same menu, just under the button.
  const onMore = useCallback((e: ReactMouseEvent<HTMLElement>, slot: string) => {
    const r = e.currentTarget.getBoundingClientRect();
    openMenuAt(slot, { left: r.left, top: r.bottom + 4 });
  }, [openMenuAt]);
  // "Clean up and close": asked what would be lost first. Nothing to lose closes at once; otherwise the user is asked, and
  // until they say yes nothing is stopped or removed.
  const [closing, setClosing] = useState<{ slot: string; check: CloseCheck } | null>(null);
  const [closeBusy, setCloseBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const closeAgent = (slot: string, agreed?: CloseAgreed) => {
    setCloseBusy(true);
    actions.closeWorker(slot, agreed).then(
      () => setClosing(null),
      (e) => {
        setClosing(null);
        setProblem(errText(e));
      },
    ).finally(() => setCloseBusy(false));
  };
  const askToClose = (slot: string) => {
    setProblem(null);
    actions.closeCheck(slot).then(
      (check) => (lostText(check) ? setClosing({ slot, check }) : closeAgent(slot)),
      (e) => setProblem(errText(e)),
    );
  };
  // A card that offers "Close agent" (a setup that failed) asks the same way the menu does: through one function that never changes.
  const askRef = useRef(askToClose);
  askRef.current = askToClose;
  const closeAsk = useCallback((slot: string) => askRef.current(slot), []);
  // "Close stopped agents": every stopped agent of the team, checked first. When none has work to lose they are closed at once; when some
  // do, one question names them and what each would lose, and nothing is closed until it is answered (Close all, Keep those, Cancel).
  const [bulk, setBulk] = useState<ClosePlan | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const noteTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(noteTimer.current), []);
  const say = (text: string) => {
    window.clearTimeout(noteTimer.current);
    setNote(text);
    noteTimer.current = window.setTimeout(() => setNote(null), 9000);
  };
  const stillStopped = (slot: string) => isStopped(store.get(slot));
  const finishClosing = (agents: Parameters<typeof closeAll>[0], refused: ClosePlan["refused"], skipped: number) => {
    setCloseBusy(true);
    closeAll(agents, { closeWorker: actions.closeWorker, stillStopped }).then((out) => {
      setBulk(null);
      setCloseBusy(false);
      say(closedLine(out.closed, out.kept + refused.length + skipped, [...out.problems, ...refused.map((r) => `${r.name}: ${r.reason}`)]));
    });
  };
  const closeStopped = () => {
    setProblem(null);
    setNote(null);
    const agents = stoppedAgents(nodesNow.current, store.get);
    if (agents.length === 0) return say("No agents have stopped.");
    planClosing(agents, actions.closeCheck).then((plan) => {
      if (plan.risky.length > 0) setBulk(plan);
      else if (plan.free.length > 0) finishClosing(plan.free, plan.refused, 0);
      else say(closedLine(0, plan.refused.length, plan.refused.map((r) => `${r.name}: ${r.reason}`)));
    });
  };
  useAction("close-stopped-agents", closeStopped);
  const menuNode = menu ? nodes.find((n) => n.slot === menu.slot) : undefined;
  const menuItems = (n: OrchestraNode): AgentMenuItem[] => {
    const needsYou = attention.includes(n.slot);
    return [
      {
        key: "hide",
        label: "Hide",
        hint: needsYou ? "It needs you now, so it stays" : "Takes the card off the canvas. It keeps working and reporting.",
        disabled: needsYou,
        run: () => {
          setMenu(null);
          actions.hide(n.slot);
        },
      },
      {
        key: "close",
        label: "Clean up and close",
        hint: n.isolation === "shared" ? "Stops it and removes its card. It shares your folder, so no files are removed." : "Stops it, deletes its worktree and branch, and removes its card.",
        danger: true,
        run: () => {
          setMenu(null);
          askToClose(n.slot);
        },
      },
    ];
  };

  // A hidden agent that starts waiting on the user comes back by itself, so it can't sit blocked where nobody sees it.
  const hiddenWaiting = attention.filter((slot) => nodes.some((n) => n.slot === slot && n.hidden)).join(",");
  useEffect(() => {
    for (const slot of hiddenWaiting.split(",").filter(Boolean)) actions.show(slot);
  }, [hiddenWaiting, actions]);

  const zoomBy = (factor: number) => {
    touch();
    apply(zoomAt(view.current, factor, { x: size.current.w / 2, y: size.current.h / 2 }), true);
  };

  /** Brings one agent to the middle of the canvas, zoomed in far enough to read its chat. */
  const goTo = useCallback((slot: string) => {
    const box = layout.boxes[slot];
    if (!box) return;
    // An agent that was hidden is put back first: there is nothing to go to otherwise.
    if (nodes.some((n) => n.slot === slot && n.hidden)) actions.show(slot);
    layout.touched = true;
    // At 100%, however small the view was, but never past what fits: an agent taller than the canvas is shown whole, however small that is.
    const fits = size.current.w > 0 && size.current.h > 0 ? Math.min(1, (size.current.w - 48) / box.w, (size.current.h - 48) / shown(slot).h) : 1;
    apply(centerOn(shown(slot), size.current, clampZoom(fits)), true);
    onFocus(slot);
    bringToFront(slot);
  }, [layout, nodes, actions, apply, onFocus, bringToFront]);
  const next = () => {
    if (attention.length === 0) return;
    goTo(attention[nextAttention.current++ % attention.length]);
  };
  // While the canvas has focus: ⌘= ⌘− ⌘0 zoom and fit, ⌘] ⌘[ go to the next and the previous agent.
  const [hasFocus, setHasFocus] = useState(false);
  const cycle = (delta: number) => {
    const slots = shownSlots.current;
    if (slots.length === 0) return;
    const at = slots.indexOf(activeSlot);
    goTo(slots[(at + delta + slots.length * 2) % slots.length]);
  };
  useAction("canvas-zoom-in", () => zoomBy(1.25), hasFocus);
  useAction("canvas-zoom-out", () => zoomBy(1 / 1.25), hasFocus);
  useAction("canvas-fit", () => { layout.touched = false; fit(true); }, hasFocus);
  useAction("canvas-next-agent", () => cycle(1), hasFocus);
  useAction("canvas-previous-agent", () => cycle(-1), hasFocus);

  const initial = view.current;
  return (
    <div
      className={`canvas${summary ? " summary" : ""}`}
      ref={viewport}
      data-testid="canvas"
      style={{ "--zoom": initial.zoom, "--vx": `${initial.x}px`, "--vy": `${initial.y}px` } as CSSProperties}
      onFocus={() => setHasFocus(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setHasFocus(false)}
      onPointerDown={onBackgroundDown}
      onPointerMove={onBackgroundMove}
      onPointerUp={onBackgroundUp}
      onPointerCancel={onBackgroundUp}
    >
      <CloseAgentContext.Provider value={closeAsk}>
      <div className="canvas-world" ref={world} style={{ transform: `translate(${initial.x}px, ${initial.y}px) scale(${initial.zoom})` }}>
        <svg className="canvas-tethers" aria-hidden>
          {visible.map((n) => {
            const parent = n.parent ? layout.boxes[n.parent] : undefined;
            const box = layout.boxes[n.slot];
            return parent && box ? <TetherLine key={n.slot} slot={n.slot} d={tether(shown(n.parent!), shown(n.slot)).d} fresh={arriving.has(n.slot)} /> : null;
          })}
        </svg>
        {visible.map((n) => (
          <Frame
            key={n.slot}
            slot={n.slot}
            parent={n.parent}
            role={n.role}
            name={n.name}
            branch={n.branch}
            agentRole={n.agentRole}
            readOnly={n.role === "worker" && (!!n.agentRole?.read_only || n.isolation === "shared")}
            box={layout.boxes[n.slot]}
            z={layout.order.indexOf(n.slot) + 1}
            focused={n.slot === activeSlot}
            summary={summary}
            collapsed={!!layout.collapsed[n.slot]}
            fresh={arriving.has(n.slot)}
            holdsAgents={n.role === "main" && nodes.some((o) => o.parent === n.slot)}
            onGrab={onGrab}
            onDrag={onDrag}
            onRelease={onRelease}
            onToggle={onToggle}
            onOpen={onOpen}
            onPress={onPress}
            onMenu={onMenu}
            onMore={onMore}
          />
        ))}
      </div>
      </CloseAgentContext.Provider>
      <Announcer nodes={nodes} />
      <Controls zoom={zoomPct} attention={attention.length} nodes={nodes} onZoom={zoomBy} onFit={() => { layout.touched = false; fit(true); }} onNext={next} onGoTo={goTo} onShow={actions.show} onCloseStopped={closeStopped} main={nodes.find((n) => n.role === "main")?.slot} />
      {problem && (
        <div className="canvas-problem canvas-overlay" role="alert">
          <span>{problem}</span>
          <button onClick={() => setProblem(null)}>Dismiss</button>
        </div>
      )}
      {note && (
        <div className="canvas-note canvas-overlay" role="status">
          <span>{note}</span>
          <button onClick={() => setNote(null)}>Dismiss</button>
        </div>
      )}
      {unseen.length > 0 && (
        <button className="canvas-new canvas-overlay" onClick={() => goTo(unseen[0])} title="Go to the agent that was just added, off the edge of what you are looking at">
          {unseen.length === 1 ? "1 new agent" : `${unseen.length} new agents`}
        </button>
      )}
      {bulk && (
        <ConfirmDialog
          title="Close stopped agents?"
          confirmLabel="Close all"
          busyLabel="Closing…"
          busy={closeBusy}
          onConfirm={() => finishClosing([...bulk.free, ...bulk.risky.map((a) => ({ ...a, agreed: agreedOf(a.check) }))], bulk.refused, 0)}
          alternative={{ label: "Keep those", onClick: () => (bulk.free.length > 0 ? finishClosing(bulk.free, bulk.refused, bulk.risky.length) : (setBulk(null), say(closedLine(0, bulk.risky.length + bulk.refused.length)))) }}
          onCancel={() => setBulk(null)}
        >
          <p>{riskyQuestion(bulk.risky)}</p>
          <p>{bulkEffect(bulk.risky)}, so that work is gone for good.{bulk.free.length > 0 ? ` ${bulk.free.length === 1 ? "1 other stopped agent has" : `${bulk.free.length} other stopped agents have`} nothing to lose and will be closed either way.` : ""}</p>
        </ConfirmDialog>
      )}
      {closing && (
        <ConfirmDialog title={`Close ${nodes.find((n) => n.slot === closing.slot)?.name ?? "this agent"}?`} confirmLabel="Discard work and close" busyLabel="Closing…" busy={closeBusy} onConfirm={() => closeAgent(closing.slot, { uncommitted: closing.check.uncommitted, unmerged_commits: closing.check.unmerged_commits })} onCancel={() => setClosing(null)}>
          <p>
            It has <strong>{lostText(closing.check)}</strong>.{" "}
            {closing.check.gone ? "Its worktree is already gone. Closing it stops it and deletes" : "Closing it stops it and deletes its worktree"}
            {closing.check.branch ? <>{closing.check.gone ? " its" : " and"} branch <code>{closing.check.branch}</code></> : null}, so that work is gone for good.
          </p>
        </ConfirmDialog>
      )}
      {menu && menuNode && <AgentMenu name={menuNode.name} items={menuItems(menuNode)} x={menu.x} y={menu.y} onDismiss={() => setMenu(null)} />}
    </div>
  );
}
