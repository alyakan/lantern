import { beginDictation, dictate, dictationProblem, needsSettings, pickLanguage } from "./dictation";

describe("what dictation writes into the box", () => {
  it("shows what is heard as it comes, each guess replacing the last", () => {
    let d = beginDictation("");
    d = dictate(d, "hello", false);
    expect(d.shown).toBe("hello");
    d = dictate(d, "hello there", false);
    expect(d.shown).toBe("hello there");
  });

  it("adds to what the box already says, with one space between", () => {
    expect(dictate(beginDictation("Fix the bug"), "in the parser", false).shown).toBe("Fix the bug in the parser");
    expect(dictate(beginDictation("Fix it. "), "Then test", false).shown).toBe("Fix it. Then test");
    expect(dictate(beginDictation("Fix it.\n"), "Then test", false).shown).toBe("Fix it.\nThen test");
  });

  it("keeps a finished stretch and goes on after it", () => {
    let d = beginDictation("");
    d = dictate(d, "first part", true);
    d = dictate(d, "second", false);
    expect(d.shown).toBe("first part second");
    d = dictate(d, "second part", true);
    d = dictate(d, "third", true);
    expect(d.shown).toBe("first part second part third");
  });

  it("never writes a leading '!', which would turn the box into a terminal", () => {
    expect(dictate(beginDictation(""), "! rm -rf", false).shown).toBe("rm -rf");
    expect(dictate(beginDictation(""), "!!ls", true).shown).toBe("ls");
    // What the person typed is theirs to keep.
    expect(dictate(beginDictation("hey!"), "you", true).shown).toBe("hey! you");
  });

  it("ignores empty results", () => {
    expect(dictate(beginDictation("hi"), "  ", true).shown).toBe("hi");
  });
});

describe("which language to listen in", () => {
  const apple = ["ar-SA", "de-DE", "en-AU", "en-GB", "en-US", "fr-CA", "fr-FR"];

  it("uses the phone's own language when the recognizer has it", () => {
    expect(pickLanguage("en-GB", apple)).toBe("en-GB");
    expect(pickLanguage("fr_FR", apple)).toBe("fr-FR");
  });

  it("takes a nearby one when it hasn't (a region it has no model for)", () => {
    expect(pickLanguage("en-EG", apple)).toBe("en-US");
    expect(pickLanguage("fr-CH", apple)).toBe("fr-FR");
    expect(pickLanguage("ar-EG", apple)).toBe("ar-SA");
    expect(pickLanguage("de", apple)).toBe("de-DE");
  });

  it("gives up, so that it can say so, when the language isn't there at all", () => {
    expect(pickLanguage("sw-KE", apple)).toBeNull();
  });

  it("tries the phone's language as it is when the recognizer doesn't list any", () => {
    expect(pickLanguage("en-EG", [])).toBe("en-EG");
    expect(pickLanguage(undefined, [])).toBeUndefined();
    expect(pickLanguage(undefined, apple)).toBeUndefined();
  });
});

describe("what is said when dictation can't go on", () => {
  it("points to Settings when the microphone or speech recognition was refused", () => {
    expect(dictationProblem("not-allowed")).toMatch(/Settings/);
    expect(needsSettings("not-allowed")).toBe(true);
    expect(needsSettings("service-not-allowed")).toBe(true);
    expect(needsSettings("network")).toBe(false);
  });

  it("says nothing when the person stopped it or said nothing", () => {
    for (const code of ["aborted", "no-speech", "speech-timeout", "interrupted"]) expect(dictationProblem(code)).toBeNull();
  });
});
