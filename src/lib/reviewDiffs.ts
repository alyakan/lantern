import { createContext, useContext } from "react";
import type { FileDiff } from "../types";

/** How a Review page reads a changed file's diff: the one the Changes pane shows (the pull request's, the branch's, ...). */
export interface ReviewDiffs {
  /** `path`: the changed file as the Changes list has it (a page's mention, resolved). */
  load: (path: string) => Promise<FileDiff>;
}

const Ctx = createContext<ReviewDiffs | null>(null);
export const ReviewDiffsProvider = Ctx.Provider;
/** Null outside a provider: then a finding has no code to show. */
export const useReviewDiffs = () => useContext(Ctx);
