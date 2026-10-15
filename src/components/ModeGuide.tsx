import { useEffect, useRef, useState, type ReactNode } from "react";
import { FLAVOUR_LABEL, type Flavour } from "../lib/flavour";
import { WORKFLOW_LABEL, type Permissions, type Workflow } from "../lib/workflow";
import { ArchitectureIcon, BoltIcon, BugIcon, BuildIcon, LearnIcon, OrchestraIcon, ReviewIcon, ShieldIcon, SparkIcon, StepsIcon } from "./icons";

/** A page of the guide: a Permissions setting, a Workflow, one of Step by step's flavours, or its Explain as you go option. */
export type GuideKey = Permissions | Workflow | Flavour | "explain";

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

export const FLAVOUR_ICON: Record<Flavour, ReactNode> = { build: <BuildIcon />, review: <ReviewIcon />, debug: <BugIcon />, architecture: <ArchitectureIcon /> };

/** What each Permissions setting, Workflow and flavour does, in more detail than the menus' one line. */
export const GUIDE: Record<GuideKey, About> = {
  ask: {
    label: "Ask",
    icon: <ShieldIcon />,
    summary: "Claude edits files on its own and asks before running anything. It means the same in every workflow.",
    claude: ["Reads, searches and edits files without asking", "Asks before commands, web requests and other actions"],
    you: ["Allow or deny each action from the card in the chat", "Follow the edits in the side panel's Changes tab as they land", "In a Team, every agent asks too: you answer in that agent's own window"],
    goodFor: "Everyday work where you want a say before anything runs.",
  },
  auto: {
    label: "Auto",
    icon: <BoltIcon />,
    summary: "Claude Code's auto mode: a classifier approves routine actions and stops risky ones, so you're rarely asked. It means the same in every workflow.",
    claude: ["Edits files and runs routine commands without stopping", "Still stops for an action the classifier flags as risky", "In Step by step it acts without asking, and you still review every page"],
    you: ["Check the result when it's done, in the chat and the side panel's Changes tab", "In a Team, the Lead's Auto lets its agents run on Auto too; an agent never has more freedom than its Lead"],
    goodFor: "Tasks you trust Claude with from start to finish.",
  },
  chat: {
    label: "Chat",
    icon: <SparkIcon />,
    summary: "A plain conversation. Claude works as you ask, as far as Permissions allow.",
    claude: ["Reads, searches, edits files and runs commands as your message asks", "Answers in the chat and shows each tool call as a card"],
    you: ["Send a message, and follow the edits in the side panel's Changes tab", "Switch the Workflow to Step by step or Team at any time"],
    goodFor: "Everyday work.",
  },
  steps: {
    label: "Step by step",
    icon: <StepsIcon />,
    summary: "Claude works one page at a time and stops after each one. It suggests how to work from your task: Build, Review, Debug or Design.",
    claude: [
      "Reads your task and suggests a flavour, with why, then waits for you to start it",
      "Suggests another one when the work changes (a crash during a build is a debug)",
      "Writes one page per message: a step, a file, a round of evidence",
    ],
    you: [
      "Start the flavour Claude suggests, or pick another",
      "Pick a flavour yourself from the badge in the header at any time, and turn Explain as you go on or off there; Claude is told with your next message",
      "Next approves a page; ask about a page or change it in the box",
      "Permissions, under the box, apply here as everywhere: on Auto Claude acts without asking, and you still review every page",
    ],
    goodFor: "Work you want to read and steer while it's being done.",
  },
  team: {
    label: "Team",
    icon: <OrchestraIcon />,
    summary: "This chat becomes the Lead of a team. It starts agents that each work in a chat of their own, on a canvas, and you can talk to any of them.",
    claude: [
      "Splits the work and starts agents, each in its own git worktree and branch (or in your folder, for work that only reads)",
      "Hears when an agent finishes or needs you, and reads or messages any of them",
      "Asks you to merge an agent's branch; only you can approve it",
    ],
    you: [
      "Permissions apply to the whole team, and can be changed from any window's title bar: an agent never has more freedom than its Lead",
      "Subagents, in the canvas controls, says whether the Lead's built-in subagents become agents on the canvas (the default) or run inline in its chat",
      "Drag a title to move a window; ⇧⌘C switches between the canvas and the chat view",
    ],
    goodFor: "Work that splits into parts that can run in parallel.",
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
  explain: {
    label: "Explain as you go",
    icon: <LearnIcon />,
    summary: "An option on Build and Debug: each page also covers the why, the idea behind it, how it fits, and what else it could have been.",
    claude: ["Goes through the same pages as the flavour: frame, plan, build (or evidence and fix)", "Explains each page with short sections and small code excerpts", "Says what it considered instead and why it didn't choose it"],
    you: ["Turn it on from the flavour menu in the header, or say you want to learn: for a job, an interview, a test, a codebase that's new to you", "Ask about anything you don't follow: the answer stays on the page"],
    goodFor: "Learning a language, a framework or a codebase while something real gets built or fixed.",
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
  architecture: {
    label: "Design",
    icon: <ArchitectureIcon />,
    summary: "Claude maps how a feature, a fix or a pull request fits together, and you review the design before (or without) any code.",
    claude: [
      "Frames what is being mapped and where its edges are",
      "Draws the whole picture as one diagram, with new, changed and removed parts coloured",
      "One part per page: its role, what it connects to, what changes in it, and concerns about it",
      "Ends with a summary of the concerns and your verdicts, and offers to Start Build",
      "For a PR or a fix it reads the code or the diff; for a feature that isn't built yet it proposes the design and says so",
    ],
    you: [
      "The map is in the side panel's Map tab: the part you're on is lit, hovering a box says what it does, and clicking one opens its page",
      "Agree with or reject each concern; Next sends your verdicts with it",
      "Drag the map to move it, pinch or ⌘-scroll to zoom, and Fit to see all of it again",
    ],
    goodFor: "Agreeing on a design before building it, or understanding how a change fits into the system.",
    example: "Map the architecture of PR 128",
  },
};

const GROUPS: { title: string; keys: GuideKey[] }[] = [
  { title: "Permissions", keys: ["ask", "auto"] },
  { title: "Workflow", keys: ["chat", "steps", "team"] },
  { title: "Step by step's flavours", keys: ["build", "review", "debug", "architecture", "explain"] },
];

const isFlavour = (k: GuideKey): k is Flavour => k in FLAVOUR_LABEL;
const isStepsKey = (k: GuideKey): k is Flavour | "explain" => isFlavour(k) || k === "explain";
const isPermissions = (k: GuideKey): k is Permissions => k === "ask" || k === "auto";

/** "Step by step · Review": a Workflow's full name, with the flavour it's in. */
export const workflowName = (workflow: Workflow, flavour: Flavour | null = null) => (workflow === "steps" && flavour ? `${WORKFLOW_LABEL.steps} · ${FLAVOUR_LABEL[flavour]}` : WORKFLOW_LABEL[workflow]);

interface Props {
  /** The page that's open; null: closed. */
  open: GuideKey | null;
  /** The chat's Permissions, Workflow and flavour, marked in the list and not offered as a switch. */
  permissions: Permissions;
  workflow: Workflow;
  flavour: Flavour | null;
  /** Explain as you go is on. */
  explain?: boolean;
  /** Switch the chat to a Permissions setting, a Workflow or Step by step's flavour; absent while it can't be switched (Claude is working). */
  onUse?: (key: GuideKey) => void;
  onClose: () => void;
}

/** How the modes work: Permissions, Workflows and flavours, with what Claude does in each, what you do, and what it's for. */
export function ModeGuide({ open, permissions, workflow, flavour, explain = false, onUse, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [shown, setShown] = useState<GuideKey>(open ?? permissions);
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

  const now = (k: GuideKey) => (k === "explain" ? workflow === "steps" && explain : isFlavour(k) ? workflow === "steps" && flavour === k : isPermissions(k) ? permissions === k : workflow === k);
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
            <div className="mode-guide-eyebrow">{isStepsKey(shown) ? "Step by step" : isPermissions(shown) ? "Permissions" : "Workflow"}</div>
            <h2 className="mode-guide-title">{about.label}</h2>
            <p className="mode-guide-summary">{about.summary}</p>
            <Section title="What Claude does" items={about.claude} />
            <Section title="What you do" items={about.you} />
            <h3 className="mode-guide-heading">Good for</h3>
            <p className="mode-guide-text">{about.goodFor}</p>
            {about.example && <p className="mode-guide-note">Try: “{about.example}”</p>}
            <div className="mode-guide-actions">
              {now(shown) && <span className="mode-guide-using">{shown === "explain" ? "Explain as you go is on" : isFlavour(shown) ? "You're in this flavour" : isPermissions(shown) ? "This is the chat's Permissions" : "This is the chat's Workflow"}</span>}
              <button onClick={onClose}>Close</button>
              {!now(shown) && onUse && (
                <button className="primary" onClick={() => onUse(shown)}>
                  {isStepsKey(shown) && shown !== "explain" ? `Start ${about.label}` : shown === "explain" ? "Turn it on" : `Use ${about.label}`}
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
