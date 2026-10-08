import { describe, expect, it } from "vitest";
import { readSkillNote, skillsNamed, withSkillNote } from "./skillNote";

const skills = new Set(["grill-me", "superpowers:brainstorming"]);

describe("skill notes", () => {
  it("names the skills mentioned mid-message, once each, and nothing else", () => {
    expect(skillsNamed("plan it with /grill-me and /superpowers:brainstorming, then /grill-me again; see src/x and /clear", skills)).toEqual(["grill-me", "superpowers:brainstorming"]);
  });

  it("goes before the message, and comes off it again", () => {
    const sent = withSkillNote("design the cache, /grill-me first", skills);
    expect(sent).toBe("[Lantern: the user named skills in this message: /grill-me. Use them.]\n\ndesign the cache, /grill-me first");
    expect(readSkillNote(sent)).toBe("design the cache, /grill-me first");
  });

  it("leaves slash commands and messages without skills alone", () => {
    expect(withSkillNote("/grill-me the plan", skills)).toBe("/grill-me the plan");
    expect(withSkillNote("no skills here", skills)).toBe("no skills here");
  });
});
