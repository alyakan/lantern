import type { Mode } from "../types";
import { useModeGuide } from "../lib/modeGuide";
import { StepsIcon } from "./icons";

type Flavour = "steps" | "teach" | "review";

const ABOUT: Record<Flavour, { label: string; line: string; stages: [string, string, string] }> = {
  steps: {
    label: "Build",
    line: "Claude plans and builds one small step at a time, and stops after each one so you can review it.",
    stages: ["Frames the task", "Plans one step", "Builds it when you say Next"],
  },
  teach: {
    label: "Learn",
    line: "Like Build, and every step explains the why: the idea behind it, how it fits, what else it could have been.",
    stages: ["Frames the task", "Plans and explains a step", "Builds it when you say Next"],
  },
  review: {
    label: "Review",
    line: "Claude reviews a pull request or your branch one file at a time. Agree or reject each finding as you go.",
    stages: ["Frames the change", "One file per page", "Write it up or fix it"],
  },
};

/**
 * Above the chat box of an empty Step-by-step chat: what this mode does, its three stages, and the flavour to pick,
 * so starting one isn't a guess. It goes away with the first message.
 */
export function StepsIntro({ mode, onFlavour }: { mode: Mode; onFlavour: (mode: Mode) => void }) {
  const flavour: Flavour = mode === "teach" || mode === "review" ? mode : "steps";
  const about = ABOUT[flavour];
  const guide = useModeGuide();
  return (
    <section className="steps-intro" aria-label="Step by step">
      <div className="steps-intro-head">
        <span className="steps-intro-title">
          <StepsIcon />
          Step by step
        </span>
        <div className="scope-track" role="radiogroup" aria-label="Style">
          {(["steps", "teach", "review"] as const).map((m) => (
            <button key={m} role="radio" aria-checked={flavour === m} className={flavour === m ? "active" : ""} onClick={() => onFlavour(m)}>
              {ABOUT[m].label}
            </button>
          ))}
        </div>
      </div>
      <p className="steps-intro-line">
        {about.line}
        {guide && (
          <>
            {" "}
            <button className="link-button steps-intro-more" onClick={() => guide(flavour)}>
              Read more
            </button>
          </>
        )}
      </p>
      <ol className="steps-intro-stages">
        {about.stages.map((s, i) => (
          <li key={s}>
            <span className="steps-intro-n">{i + 1}</span>
            {s}
          </li>
        ))}
      </ol>
    </section>
  );
}
