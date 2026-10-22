import { continueList } from "./listInput";

describe("typing a list", () => {
  it("starts the next number after Return on a numbered item", () => {
    expect(continueList("1. one", "1. one\n")).toEqual({ text: "1. one\n2. ", caret: 10 });
    expect(continueList("intro\n9. nine", "intro\n9. nine\n")).toEqual({ text: "intro\n9. nine\n10. ", caret: 18 });
    expect(continueList("1) one", "1) one\n")).toEqual({ text: "1) one\n2) ", caret: 10 });
  });

  it("starts the same bullet after Return on a bullet", () => {
    expect(continueList("- one", "- one\n")).toEqual({ text: "- one\n- ", caret: 8 });
    expect(continueList("• one", "• one\n")?.text).toBe("• one\n• ");
    expect(continueList("  * nested", "  * nested\n")?.text).toBe("  * nested\n  * ");
  });

  it("ends the list on Return at an empty item, taking the marker away", () => {
    expect(continueList("1. one\n2. ", "1. one\n2. \n")).toEqual({ text: "1. one\n\n", caret: 8 });
    expect(continueList("- ", "- \n")).toEqual({ text: "\n", caret: 1 });
  });

  it("splits an item in two when Return is pressed in the middle of it, and does nothing on a blank line", () => {
    expect(continueList("- ab", "- a\nb")).toEqual({ text: "- a\n- b", caret: 6 });
    expect(continueList("1. one\nafter", "1. one\n\nafter")).toBeNull();
    expect(continueList("- a\n- b", "- a\n\n- b")).toBeNull();
  });

  it("leaves everything else alone: plain lines, pastes, deletions, other edits", () => {
    expect(continueList("hello", "hello\n")).toBeNull();
    expect(continueList("1. one", "1. one\n\n")).toBeNull();
    expect(continueList("1. one", "1. onee")).toBeNull();
    expect(continueList("1. one\n2. two", "1. one")).toBeNull();
    expect(continueList("", "1. paste\n2. paste\n")).toBeNull();
    expect(continueList("10000. too long to be a list", "10000. too long to be a list\n")).toBeNull();
    expect(continueList("-no space", "-no space\n")).toBeNull();
  });
});
