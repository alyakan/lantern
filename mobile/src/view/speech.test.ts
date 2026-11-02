import { SPOKEN_MAX, spokenText } from "./speech";

describe("spokenText", () => {
  it("reads the words and drops the marks", () => {
    expect(spokenText("# Done\n\nI fixed **the bug** in `main.rs` and [opened a PR](https://x.test/1).\n\n- one\n- two")).toBe("Done\nI fixed the bug in main.rs and opened a PR.\none\ntwo");
  });

  it("names code and tables instead of reading them out", () => {
    expect(spokenText("Run this:\n\n```bash\nrm -rf /\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |")).toBe("Run this:\nThere is a bash code block here.\nThere is a table here.");
    expect(spokenText("```\nx\n```")).toBe("There is a code block here.");
  });

  it("is empty for nothing to say", () => {
    expect(spokenText("")).toBe("");
    expect(spokenText("---")).toBe("");
  });

  it("cuts a long message at a sentence and says there is more", () => {
    const long = Array.from({ length: 400 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const spoken = spokenText(long);
    expect(spoken.length).toBeLessThanOrEqual(SPOKEN_MAX + 40);
    expect(spoken.endsWith("There is more in the chat.")).toBe(true);
    expect(spoken.split("\n")[0].endsWith(".")).toBe(true);
  });
});
