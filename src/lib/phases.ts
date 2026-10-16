import type { Flavour } from "./flavour";
import type { Heading, StepPage } from "./steps";

/** A stage of a flavour's flow, named in the header: the page kinds that belong to it. */
export interface Phase {
  name: string;
  kinds: Heading["kind"][];
}

/** The stages each flavour goes through, in order. */
export const PHASES: Record<Flavour, Phase[]> = {
  build: [
    { name: "Frame", kinds: ["frame"] },
    { name: "Plan", kinds: ["plan", "plan-complete"] },
    { name: "Build", kinds: ["step", "plan-update", "fix"] },
    { name: "Done", kinds: ["done"] },
  ],
  debug: [
    { name: "Frame", kinds: ["frame"] },
    { name: "Evidence", kinds: ["evidence"] },
    { name: "Fix", kinds: ["fix", "step"] },
    { name: "Done", kinds: ["done"] },
  ],
  review: [
    { name: "Frame", kinds: ["frame"] },
    { name: "Files", kinds: ["file"] },
    { name: "Summary", kinds: ["summary"] },
  ],
  architecture: [
    { name: "Frame", kinds: ["frame"] },
    { name: "Overview", kinds: ["overview"] },
    { name: "Parts", kinds: ["part"] },
    { name: "Summary", kinds: ["summary"] },
  ],
};

/**
 * Which stage each page is in. A page that isn't one of the flavour's headings (a suggestion, a reply Claude gave no
 * heading) stays in the stage before it, or the first.
 */
export function phasesOf(flavour: Flavour, pages: StepPage[]): number[] {
  const phases = PHASES[flavour];
  let at = 0;
  return pages.map((p) => {
    const found = phases.findIndex((phase) => p.heading && phase.kinds.includes(p.heading.kind));
    if (found >= 0) at = found;
    return at;
  });
}
