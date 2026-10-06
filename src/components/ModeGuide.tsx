import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Mode } from "../types";
import { BoltIcon, BugIcon, PlanIcon, ShieldIcon, StepsIcon } from "./icons";

interface About {
  label: string;
  icon: ReactNode;
  summary: string;
  claude: string[];
  you: string[];
  goodFor: string;
}

/** What each mode does, in more detail than the menu's one line. */
export const GUIDE: Record<Mode, About> = {
  ask: {
    label: "Ask before actions",
    icon: <ShieldIcon />,
    summary: "A normal chat. Claude edits files on its own and asks before running anything.",
    claude: ["Reads, searches and edits files without asking", "Asks before commands, web requests and other actions"],
    you: ["Allow or deny each action from the card in the chat", "Follow the edits in the Changes pane as they land"],
    goodFor: "Everyday work where you want a say before anything runs.",
  },
  auto: {
    label: "Auto-approve",
    icon: <BoltIcon />,
    summary: "Claude Code's auto mode: a classifier approves routine actions and stops risky ones, so you're rarely asked.",
    claude: ["Edits files and runs routine commands without stopping", "Still stops for an action the classifier flags as risky"],
    you: ["Check the result when it's done, in the chat and the Changes pane"],
    goodFor: "Tasks you trust Claude with from start to finish.",
  },
  plan: {
    label: "Plan first",
    icon: <PlanIcon />,
    summary: "Claude researches and writes a plan. Nothing in your project changes until you approve it.",
    claude: ["Reads the code and asks questions, without changing anything", "Proposes a plan, in a card you approve or send back"],
    you: ["Approve the plan, or keep planning and say what to change", "Once it's approved, Claude carries on in the chat mode you used last (Ask, Auto-approve or Debug)"],
    goodFor: "Bigger changes, where you want to agree on the approach first.",
  },
  debug: {
    label: "Debug",
    icon: <BugIcon />,
    summary: "Claude finds the cause of a bug from evidence before changing anything.",
    claude: [
      "Lists the likely causes, most likely first",
      "Adds temporary logs that tell them apart, all marked lantern-debug",
      "Reproduces the bug itself, or gives you a card with the steps when only you can",
      "Fixes the cause it confirmed, then removes every temporary log",
    ],
    you: ["Reproduce the bug when the card asks, and paste what you saw", "Say if it couldn't be reproduced: Claude adjusts the logs and asks again"],
    goodFor: "Bugs whose cause isn't obvious.",
  },
  steps: {
    label: "Build",
    icon: <StepsIcon />,
    summary: "Claude plans and builds one small step at a time and stops after each one. Every step is a page you review.",
    claude: [
      "Frames the task: what it understood and what's unclear",
      "Plans one step per page (the files, the change, how to check it), then sums up the plan",
      "Builds one step per page, saying what changed and how it checked it",
      "Follows your incremental-dev skill if you have one",
    ],
    you: [
      "Next approves the page, and Claude goes on to the next step",
      "Ask about a step or change it in the box: the discussion stays on its page",
      "Send & next (⌘Enter) sends a change and approves the step in one go",
      "Auto-approve, in the header, lets Claude act without asking; you still review every page",
    ],
    goodFor: "Work you want to read and steer while it's being done.",
  },
  teach: {
    label: "Learn",
    icon: <StepsIcon />,
    summary: "Build, explained. Each step also covers the why: the idea behind it, how it fits, and what else it could have been.",
    claude: ["Goes through the same pages as Build: frame, plan, build", "Explains each step with short sections and small code excerpts", "Says what it considered instead and why it didn't choose it"],
    you: ["Next approves the page, as in Build", "Ask about anything you don't follow: the answer stays on the step's page"],
    goodFor: "Unfamiliar code, a new language or framework, or learning a codebase.",
  },
  review: {
    label: "Review",
    icon: <StepsIcon />,
    summary: "Claude reviews a pull request or your branch one file at a time. Nothing is posted to GitHub.",
    claude: [
      "Frames the change: what it claims to do, and the order it will read the files in",
      "One file per page: what changed, findings with their line and severity, and notes",
      "Ends with a summary of every finding and your verdict on it",
      "Follows your incremental-pr-review skill if you have one",
    ],
    you: [
      "Agree with or reject each finding; Next file sends your verdicts with it",
      "A rejected finding is dropped for good",
      "Ask about a file in the box: the answer stays on that file's page",
      "At the summary, have the findings written up, or fixed step by step",
    ],
    goodFor: "Someone else's pull request, or your own branch before you open one.",
  },
};

const GROUPS: { title: string; modes: Mode[]; note?: string }[] = [
  { title: "Chat", modes: ["ask", "auto", "plan", "debug"] },
  { title: "Step by step", modes: ["steps", "teach", "review"], note: "You can switch between Build, Learn and Review in the middle of a chat: Claude is told when you send your next message." },
];

/** "Step by step · Review": a mode's full name. */
export const modeName = (mode: Mode) => (mode === "steps" || mode === "teach" || mode === "review" ? `Step by step · ${GUIDE[mode].label}` : GUIDE[mode].label);

interface Props {
  /** The mode whose page is open; null: closed. */
  open: Mode | null;
  /** The chat's mode, marked in the list and not offered as a switch. */
  current: Mode;
  /** Switch the chat to a mode; absent while it can't be switched (Claude is working). */
  onUse?: (mode: Mode) => void;
  onClose: () => void;
}

/** How the modes work: every mode with what Claude does in it, what you do, and what it's for. */
export function ModeGuide({ open, current, onUse, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [shown, setShown] = useState<Mode>(open ?? current);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // jsdom has no showModal or close: there, the attribute alone opens and closes it.
    if (open) {
      setShown(open);
      if (el.open) return;
      if (el.showModal) el.showModal();
      else el.setAttribute("open", "");
    } else if (el.open) {
      if (el.close) el.close();
      else el.removeAttribute("open");
    }
  }, [open]);

  const about = GUIDE[shown];
  const group = GROUPS.find((g) => g.modes.includes(shown))!;
  return (
    <dialog ref={ref} className="mode-guide" aria-label="How the modes work" onClose={onClose} onClick={(e) => e.target === e.currentTarget && onClose()}>
      {open && (
        <div className="mode-guide-body">
          <nav className="mode-guide-nav" aria-label="Modes">
            {GROUPS.map((g) => (
              <div key={g.title} className="mode-guide-group">
                <div className="mode-guide-group-title">{g.title}</div>
                {g.modes.map((m) => (
                  <button key={m} className={`mode-guide-tab${m === shown ? " active" : ""}`} aria-current={m === shown ? "page" : undefined} onClick={() => setShown(m)}>
                    <span className="mode-icon">{GUIDE[m].icon}</span>
                    {GUIDE[m].label}
                    {m === current && <span className="mode-guide-now">Now</span>}
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <article className="mode-guide-page">
            <div className="mode-guide-eyebrow">{group.title === "Chat" ? "Chat mode" : "Step by step"}</div>
            <h2 className="mode-guide-title">{about.label}</h2>
            <p className="mode-guide-summary">{about.summary}</p>
            <Section title="What Claude does" items={about.claude} />
            <Section title="What you do" items={about.you} />
            <h3 className="mode-guide-heading">Good for</h3>
            <p className="mode-guide-text">{about.goodFor}</p>
            {group.note && <p className="mode-guide-note">{group.note}</p>}
            <div className="mode-guide-actions">
              {shown === current && <span className="mode-guide-using">You're in this mode</span>}
              <button onClick={onClose}>Close</button>
              {shown !== current && onUse && (
                <button className="primary" onClick={() => onUse(shown)}>
                  Use {modeName(shown)}
                </button>
              )}
            </div>
          </article>
        </div>
      )}
    </dialog>
  );
}

function Section({ title, items }: { title: string; items: string[] }) {
  return (
    <>
      <h3 className="mode-guide-heading">{title}</h3>
      <ul className="mode-guide-list">
        {items.map((it) => (
          <li key={it}>{it}</li>
        ))}
      </ul>
    </>
  );
}
