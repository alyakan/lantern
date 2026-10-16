import { useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Flavour } from "../lib/flavour";
import { useModeGuide } from "../lib/modeGuide";
import { TemplateTeamContext } from "../lib/roleStore";
import { useMenuInside } from "../lib/useMenuInside";
import { PERMISSIONS_LABEL, type Permissions, type Workflow, WORKFLOW_LABEL } from "../lib/workflow";
import { BoltIcon, InfoIcon, OrchestraIcon, ShieldIcon, SparkIcon, StepsIcon } from "./icons";
import { workflowName, type GuideKey } from "./ModeGuide";
import { useMenuKeys } from "./useMenuKeys";

const PERMISSION_ROWS: { value: Permissions; hint: string; icon: ReactNode }[] = [
  { value: "ask", hint: "Edits apply; commands and other actions ask you first", icon: <ShieldIcon /> },
  { value: "auto", hint: "A classifier approves most actions; you're rarely asked", icon: <BoltIcon /> },
];

const WORKFLOW_ROWS: { value: Workflow; hint: string; icon: ReactNode }[] = [
  { value: "chat", hint: "A plain conversation: Claude works as you ask", icon: <SparkIcon /> },
  { value: "steps", hint: "One page at a time: Claude suggests whether to build, review, debug or design, and you start it", icon: <StepsIcon /> },
  { value: "team", hint: "This chat becomes the Lead of a team: it starts agents that work in parallel, each in a chat of its own", icon: <OrchestraIcon /> },
];

interface Row<T extends string> {
  value: T;
  label: string;
  hint: string;
  icon: ReactNode;
  /** Why it can't be picked now; the row is shown but off. */
  off?: string;
}

interface MenuProps<T extends string> {
  /** The menu's name, for assistive tech: "Permissions" or "Workflow". */
  name: string;
  value: T;
  /** The chip's text. */
  text: string;
  rows: Row<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  /** A title bar's chip: small, with no icon, and a menu that opens downwards. */
  compact?: boolean;
  /** The "How the modes work…" page this menu's row opens on. */
  guideKey: GuideKey;
  /** A row of its own under the choices that does something instead of choosing ("Team from a template…"). */
  extra?: { label: string; hint: string; icon: ReactNode; run: () => void };
}

// A chip with a menu: under the chat box it opens upwards like the model chip, on a canvas title bar downwards.
function SettingMenu<T extends string>({ name, value, text, rows, onChange, disabled, compact, guideKey, extra }: MenuProps<T>) {
  const [open, setOpen] = useState(false);
  const guide = useModeGuide();
  const root = useRef<HTMLDivElement>(null);
  const keys = useMenuKeys(open, root);
  // The chat column clips what sticks out of it, so the menu stays inside it sideways and inside the window vertically.
  const { ref: menu, style: menuStyle } = useMenuInside(open);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = rows.find((r) => r.value === value) ?? rows[0];
  return (
    <div className={`model-picker mode-menu-anchor${compact ? " compact" : ""}`} ref={root}>
      <button
        className={compact ? "node-chip" : "meta-item mode-chip"}
        aria-label={`${name}: ${text}`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        title={`${name}: ${current.hint}`}
        onClick={() => setOpen(!open)}
      >
        {!compact && current.icon}
        {text}
        <span className="chev down" aria-hidden />
      </button>
      {open && (
        <div className={`menu model-menu mode-menu${compact ? " below" : ""}`} ref={menu} style={menuStyle} role="menu" aria-label={name} onKeyDown={keys.onKeyDown}>
          {rows.map((r) => (
            <button
              key={r.value}
              role="menuitemradio"
              aria-checked={r.value === value}
              disabled={!!r.off}
              title={r.off}
              className={`menu-row${r.value === value ? " current" : ""}`}
              onClick={() => {
                setOpen(false);
                if (r.value !== value) onChange(r.value);
              }}
            >
              <span className="mode-icon">{r.icon}</span>
              <span className="mode-text">
                <span className="menu-row-title">{r.label}</span>
                <span className="mode-hint">{r.off ?? r.hint}</span>
              </span>
            </button>
          ))}
          {extra && (
            <>
              <div className="menu-sep" role="separator" />
              <button
                role="menuitem"
                className="menu-row"
                onClick={() => {
                  setOpen(false);
                  extra.run();
                }}
              >
                <span className="mode-icon">{extra.icon}</span>
                <span className="mode-text">
                  <span className="menu-row-title">{extra.label}</span>
                  <span className="mode-hint">{extra.hint}</span>
                </span>
              </button>
            </>
          )}
          {guide && (
            <>
              <div className="menu-sep" role="separator" />
              <button
                role="menuitem"
                className="menu-row mode-menu-more"
                onClick={() => {
                  setOpen(false);
                  guide(guideKey);
                }}
              >
                <span className="mode-icon">
                  <InfoIcon />
                </span>
                <span className="menu-row-title">How the modes work…</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

interface PermissionsProps {
  permissions: Permissions;
  onChange: (permissions: Permissions) => void;
  disabled?: boolean;
  compact?: boolean;
}

/** Permissions: how much Claude may do without asking (Ask or Auto), the same in every workflow. */
export function PermissionsMenu({ permissions, onChange, disabled, compact }: PermissionsProps) {
  const rows = PERMISSION_ROWS.map((r) => ({ ...r, label: PERMISSIONS_LABEL[r.value] }));
  return <SettingMenu name="Permissions" value={permissions} text={PERMISSIONS_LABEL[permissions]} rows={rows} onChange={onChange} disabled={disabled} compact={compact} guideKey={permissions} />;
}

interface WorkflowProps {
  workflow: Workflow;
  /** Step by step's flavour, shown with it. */
  flavour?: Flavour | null;
  onChange: (workflow: Workflow) => void;
  disabled?: boolean;
  compact?: boolean;
  /** An agent of a team: its workflow is Chat or Step by step, and the team is its Lead's. */
  agent?: boolean;
  /** A Lead that still has agents: it stays in Team until they are closed. */
  holdsAgents?: boolean;
}

/** Workflow: how the work is shaped (Chat, Step by step or Team). */
export function WorkflowMenu({ workflow, flavour = null, onChange, disabled, compact, agent, holdsAgents }: WorkflowProps) {
  const held = holdsAgents ? "This team still has agents. Close them first." : undefined;
  const rows: Row<Workflow>[] = WORKFLOW_ROWS.filter((r) => !(agent && r.value === "team")).map((r) => ({ ...r, label: WORKFLOW_LABEL[r.value], off: r.value !== "team" ? held : undefined }));
  // A new team from a template is offered where a team could be started: not on an agent, a title bar, or a team that has agents.
  const startTemplate = useContext(TemplateTeamContext);
  const extra = startTemplate && !agent && !compact && !holdsAgents ? { label: "Team from a template…", hint: "Start a team with its agents already chosen: a builder and a reviewer, say", icon: <OrchestraIcon />, run: startTemplate } : undefined;
  return <SettingMenu name="Workflow" value={workflow} text={workflowName(workflow, flavour)} rows={rows} onChange={onChange} disabled={disabled} compact={compact} guideKey={workflow === "steps" && flavour ? flavour : workflow} extra={extra} />;
}
