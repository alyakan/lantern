import type { Flavour } from "./flavour";

/**
 * The names a flavour has had, for reading what Claude wrote and what older chats saved: Learn and Teach became Build with
 * Explain as you go, and Architecture is Design.
 */
export const FLAVOUR_WORDS = "Build|Learn|Teach|Review|Debug|Design|Architecture";

/** What a flavour's name in a heading, note or answer means now: the flavour, and whether Explain as you go is on. */
export function flavourWord(word: string): { flavour: Flavour; explain: boolean } {
  const w = word.toLowerCase();
  if (w === "learn" || w === "teach") return { flavour: "build", explain: true };
  return { flavour: w === "design" ? "architecture" : (w as Flavour), explain: false };
}

/** What follows a flavour's name when Explain as you go is on: "Start Build, explaining as you go." */
export const EXPLAINING = ",\\s*explaining as you go";
