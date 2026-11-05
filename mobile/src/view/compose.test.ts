import { guessProject } from "./compose";

const projects = [
  { id: "/a/lantern", name: "lantern" },
  { id: "/a/lantern-mobile", name: "lantern-mobile" },
  { id: "/a/rayak", name: "rayak" },
];

describe("guessProject", () => {
  it("takes a project named in the words, as a word of its own", () => {
    expect(guessProject("fix the games timer in Rayak please", projects, null)).toEqual({ project: projects[2], guessed: true });
    expect(guessProject("in lantern-mobile the tab bar flickers", projects, "/a/rayak")).toEqual({ project: projects[1], guessed: true });
  });

  it("doesn't read a name inside another word", () => {
    expect(guessProject("the lanterns on the porch", projects, "/a/rayak")).toEqual({ project: projects[2], guessed: false });
  });

  it("falls back to the last project, then the Mac's first", () => {
    expect(guessProject("make it faster", projects, "/a/rayak")).toEqual({ project: projects[2], guessed: false });
    expect(guessProject("make it faster", projects, "/gone")).toEqual({ project: projects[0], guessed: false });
    expect(guessProject("anything", [], null)).toBeNull();
  });
});
