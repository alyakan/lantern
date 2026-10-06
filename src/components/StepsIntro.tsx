import { FLAVOURS, type Flavour } from "../lib/flavour";
import { useModeGuide } from "../lib/modeGuide";
import { StepsIcon } from "./icons";
import { FLAVOUR_ICON, GUIDE } from "./ModeGuide";

/**
 * Above the chat box of an empty Step-by-step chat: Claude will suggest how to work from what you ask, and what to ask
 * for each way (Learn, especially, is only suggested when you say you want to learn). A flavour can be picked here
 * instead, and then Claude starts in it without asking. It goes away with the first message.
 */
export function StepsIntro({ picked, onPick }: { picked: Flavour | null; onPick: (flavour: Flavour | null) => void }) {
  const guide = useModeGuide();
  return (
    <section className="steps-intro" aria-label="Step by step">
      <div className="steps-intro-head">
        <span className="steps-intro-title">
          <StepsIcon />
          Step by step
        </span>
      </div>
      <p className="steps-intro-line">
        Say what you're after and Claude suggests how to work on it, one page at a time. Or pick one here.
        {guide && (
          <>
            {" "}
            <button className="link-button steps-intro-more" onClick={() => guide(picked ?? "steps")}>
              Read more
            </button>
          </>
        )}
      </p>
      <div className="steps-intro-flavours" role="group" aria-label="Flavours">
        {FLAVOURS.map((f) => (
          <button key={f} className={`steps-intro-flavour${picked === f ? " picked" : ""}`} aria-pressed={picked === f} onClick={() => onPick(picked === f ? null : f)}>
            <span className="steps-intro-flavour-name">
              {FLAVOUR_ICON[f]}
              {GUIDE[f].label}
            </span>
            <span className="steps-intro-flavour-example">“{GUIDE[f].example}”</span>
          </button>
        ))}
      </div>
    </section>
  );
}
