import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Mode } from "../types";
import { FLAVOUR_LABEL, type Flavour } from "../lib/flavour";
import { BoltIcon, BugIcon, BuildIcon, LearnIcon, ReviewIcon, ShieldIcon, StepsIcon } from "./icons";

/** A page of the guide: a mode, or one of Step by step's flavours. */
export type GuideKey = Mode | Flavour;

interface About {
  label: string;
  icon: ReactNode;
  summary: string;
  claude: string[];
  you: string[];
  goodFor: string;
  /** What to ask for to get this flavour, as an example. */
  example?: string;
}

export const FLAVOUR_ICON: Record<Flavour, ReactNode> = { build: <BuildIcon />, learn: <LearnIcon />, review: <ReviewIcon />, debug: <BugIcon /> };

/** What each mode and flavour does, in more detail than the menus' one line. */
export const GUIDE: Record<GuideKey, About> = {
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
  steps: {
    label: "Step by step",
    icon: <StepsIcon />,
    summary: "Claude works one page at a time and stops after each one. It suggests how to work from your task: Build, Learn, Review or Debug.",
    claude: [
      "Reads your task and suggests a flavour, with why, then waits for you to start it",
      "Suggests another one when the work changes (a crash during a build is a debug)",
      "Writes one page per message: a step, a file, a round of evidence",
    ],
    you: [
      "Start the flavour Claude suggests, or pick another",
      "Pick a flavour yourself from the badge in the header at any time; Claude is told with your next message",
      "Next approves a page; ask about a page or change it in the box",
      "Auto-approve, in the header, lets Claude act without asking; you still review every page",
    ],
    goodFor: "Work you want to read and steer while it's being done.",
  },
  build: {
    label: "Build",
    icon: <BuildIcon />,
    summary: "Claude plans and builds one small step at a time. Every step is a page you review.",
    claude: [
      "Frames the task: what it understood and what's unclear",
      "Plans one step per page (the files, the change, how to check it), then sums up the plan",
      "Builds one step per page, saying what changed and how it checked it",
      "Follows your incremental-dev skill if you have one",
    ],
    you: ["Next approves the page, and Claude goes on to the next step", "Send & next (⌘Enter) sends a change and approves the step in one go"],
    goodFor: "Adding or changing something you want to steer.",
    example: "Add retries with backoff to fetchJson",
  },
  learn: {
    label: "Learn",
    icon: <LearnIcon />,
    summary: "Build, explained. Each step also covers the why: the idea behind it, how it fits, and what else it could have been.",
    claude: ["Goes through the same pages as Build: frame, plan, build", "Explains each step with short sections and small code excerpts", "Says what it considered instead and why it didn't choose it"],
    you: ["Say you want to learn: for a job, an interview, a test, a codebase that's new to you", "Ask about anything you don't follow: the answer stays on the step's page"],
    goodFor: "Learning a language, a framework or a codebase while something real gets built.",
    example: "Teach me Swift concurrency for my interview, by building the image loader",
  },
  review: {
    label: "Review",
    icon: <ReviewIcon />,
    summary: "Claude reviews a pull request or your branch one file at a time. Nothing is posted to GitHub.",
    claude: [
      "Frames the change: what it claims to do, and the order it will read the files in",
      "One file per page: what changed, findings with their line and severity, and notes",
      "Ends with a summary of every finding and your verdict on it",
      "Follows your incremental-pr-review skill if you have one",
    ],
    you: ["Agree with or reject each finding; Next file sends your verdicts with it", "A rejected finding is dropped for good", "At the summary, have the findings written up, or fixed step by step"],
    goodFor: "Someone else's pull request, or your own branch before you open one.",
    example: "Review PR 128",
  },
  debug: {
    label: "Debug",
    icon: <BugIcon />,
    summary: "Claude finds the cause of a bug from evidence before changing anything.",
    claude: [
      "Frames the bug, with the likely causes, most likely first",
      "Adds temporary logs that tell them apart (marked lantern-debug), one page per round of evidence",
      "Reproduces the bug itself, or gives you a card with the steps when only you can",
      "Fixes the cause it confirmed, then removes every temporary log",
    ],
    you: ["Reproduce the bug when the card asks, and paste what you saw", "Say if it couldn't be reproduced: Claude adjusts the logs and asks again"],
    goodFor: "Bugs whose cause isn't obvious.",
    example: "Saving a form crashes when the title is empty",
  },
};

const GROUPS: { title: string; keys: GuideKey[] }[] = [
  { title: "Modes", keys: ["ask", "auto", "steps"] },
  { title: "Step by step's flavours", keys: ["build", "learn", "review", "debug"] },
];

const isFlavour = (k: GuideKey): k is Flavour => k in FLAVOUR_LABEL;

/** "Step by step · Review": a mode's full name, with the flavour it's in. */
export const modeName = (mode: Mode, flavour: Flavour | null = null) => (mode === "steps" && flavour ? `Step by step · ${FLAVOUR_LABEL[flavour]}` : GUIDE[mode].label);

interface Props {
  /** The page that's open; null: closed. */
  open: GuideKey | null;
  /** The chat's mode and flavour, marked in the list and not offered as a switch. */
  mode: Mode;
  flavour: Flavour | null;
  /** Switch the chat to a mode, or Step by step's flavour; absent while it can't be switched (Claude is working). */
  onUse?: (key: GuideKey) => void;
  onClose: () => void;
}

/** How the modes work: every mode and flavour with what Claude does in it, what you do, and what it's for. */
export function ModeGuide({ open, mode, flavour, onUse, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [shown, setShown] = useState<GuideKey>(open ?? mode);
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

  const now = (k: GuideKey) => (isFlavour(k) ? mode === "steps" && flavour === k : mode === k);
  const about = GUIDE[shown];
  return (
    <dialog ref={ref} className="mode-guide" aria-label="How the modes work" onClose={onClose} onClick={(e) => e.target === e.currentTarget && onClose()}>
      {open && (
        <div className="mode-guide-body">
          <nav className="mode-guide-nav" aria-label="Modes">
            {GROUPS.map((g) => (
              <div key={g.title} className="mode-guide-group">
                <div className="mode-guide-group-title">{g.title}</div>
                {g.keys.map((k) => (
                  <button key={k} className={`mode-guide-tab${isFlavour(k) ? " flavour" : ""}${k === shown ? " active" : ""}`} aria-current={k === shown ? "page" : undefined} onClick={() => setShown(k)}>
                    <span className="mode-icon">{GUIDE[k].icon}</span>
                    {GUIDE[k].label}
                    {now(k) && <span className="mode-guide-now">Now</span>}
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <article className="mode-guide-page">
            <div className="mode-guide-eyebrow">{isFlavour(shown) ? "Step by step" : "Mode"}</div>
            <h2 className="mode-guide-title">{about.label}</h2>
            <p className="mode-guide-summary">{about.summary}</p>
            <Section title="What Claude does" items={about.claude} />
            <Section title="What you do" items={about.you} />
            <h3 className="mode-guide-heading">Good for</h3>
            <p className="mode-guide-text">{about.goodFor}</p>
            {about.example && <p className="mode-guide-note">Try: “{about.example}”</p>}
            <div className="mode-guide-actions">
              {now(shown) && <span className="mode-guide-using">{isFlavour(shown) ? "You're in this flavour" : "You're in this mode"}</span>}
              <button onClick={onClose}>Close</button>
              {!now(shown) && onUse && (
                <button className="primary" onClick={() => onUse(shown)}>
                  {isFlavour(shown) ? `Start ${about.label}` : `Use ${about.label}`}
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
