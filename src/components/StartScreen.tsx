import type { ReactNode } from "react";
import { canExplain, EXPLAIN_LABEL, type Flavour } from "../lib/flavour";
import { useModeGuide } from "../lib/modeGuide";
import { OrchestraIcon, ReviewIcon } from "./icons";
import { FLAVOUR_ICON, GUIDE } from "./ModeGuide";

interface Card {
  key: string;
  name: string;
  icon: ReactNode;
  example: string;
}

/** Build, Review a PR, Debug, Design and Start a team: how a chat can start, in the order the Work menu lists them. */
const CARDS: Card[] = [
  { key: "build", name: "Build", icon: FLAVOUR_ICON.build, example: GUIDE.build.example ?? "" },
  { key: "review", name: "Review a PR", icon: <ReviewIcon />, example: "Pick one of the open pull requests" },
  { key: "debug", name: "Debug", icon: FLAVOUR_ICON.debug, example: GUIDE.debug.example ?? "" },
  { key: "architecture", name: "Design", icon: FLAVOUR_ICON.architecture, example: GUIDE.architecture.example ?? "" },
  { key: "team", name: "Start a team", icon: <OrchestraIcon />, example: "A Lead splits the work between agents" },
];

/**
 * Above the box of an empty chat, in every Workflow: say what you're after in the box, or start one of these. Build,
 * Debug and Design are Step by step in that flavour (picked here, so Claude starts in it without asking), Review a PR
 * opens a list of the open pull requests, and Start a team makes this chat a team's Lead. It goes away with the first
 * message. Build and Debug, once picked, offer Explain as you go.
 */
export function StartScreen({ picked, explain = false, team, onFlavour, onExplain, onReview, onTeam }: { picked: Flavour | null; explain?: boolean; team: boolean; onFlavour: (flavour: Flavour | null) => void; onExplain?: (on: boolean) => void; onReview: () => void; onTeam: () => void }) {
  const guide = useModeGuide();
  const isPicked = (key: string) => (key === "team" ? team : key !== "review" && picked === key);
  return (
    <section className="steps-intro start-screen" aria-label="Start">
      <p className="steps-intro-line">
        Say what you're after in the box, or start with one of these.
        {guide && (
          <>
            {" "}
            <button className="link-button steps-intro-more" onClick={() => guide(picked ?? "steps")}>
              How they work
            </button>
          </>
        )}
      </p>
      <div className="steps-intro-flavours" role="group" aria-label="Ways to start">
        {CARDS.map((c) => (
          <button
            key={c.key}
            className={`steps-intro-flavour${isPicked(c.key) ? " picked" : ""}`}
            aria-pressed={c.key === "review" ? undefined : isPicked(c.key)}
            onClick={() => (c.key === "review" ? onReview() : c.key === "team" ? onTeam() : onFlavour(picked === c.key ? null : (c.key as Flavour)))}
          >
            <span className="steps-intro-flavour-name">
              {c.icon}
              {c.name}
            </span>
            <span className="steps-intro-flavour-example">{c.key === "review" ? c.example : `“${c.example}”`}</span>
          </button>
        ))}
      </div>
      {canExplain(picked) && onExplain && (
        <label className="start-explain">
          <input type="checkbox" checked={explain} onChange={(e) => onExplain(e.target.checked)} />
          <span>
            {EXPLAIN_LABEL}
            <span className="mode-hint"> · every page also explains the why</span>
          </span>
        </label>
      )}
    </section>
  );
}
