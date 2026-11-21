import { photosFor, type SentEntry } from "./sentPhotos";

// Files by name only: expo-file-system's native side isn't on Node.
jest.mock("expo-file-system", () => {
  class Directory {}
  class File {
    uri: string;
    constructor(dir: { name?: string } | string, name?: string) {
      this.uri = typeof dir === "string" ? dir : `file:///sent/${name}`;
    }
  }
  return { Directory, File, Paths: { document: {} } };
});

const kept: SentEntry[] = [
  { slot: "a", text: "look", files: ["1-0.jpg"] },
  { slot: "b", text: "look", files: ["other.jpg"] },
  { slot: "a", text: "look", files: ["2-0.jpg", "2-1.jpg"] },
  { slot: "a", text: "", files: ["3-0.jpg"] },
];

describe("the photos kept for a chat's messages", () => {
  it("gives each message its own, the newest words to the newest photos", () => {
    const got = photosFor(kept, "a", [
      { id: "u1", text: "look" },
      { id: "u2", text: "look" },
      { id: "u3", text: "" },
    ]);
    expect(got.get("u1")).toEqual(["file:///sent/1-0.jpg"]);
    expect(got.get("u2")).toEqual(["file:///sent/2-0.jpg", "file:///sent/2-1.jpg"]);
    expect(got.get("u3")).toEqual(["file:///sent/3-0.jpg"]);
  });

  it("gives an older message nothing when fewer were kept than it has", () => {
    const got = photosFor(kept, "a", [
      { id: "u0", text: "look" },
      { id: "u1", text: "look" },
      { id: "u2", text: "look" },
    ]);
    expect(got.has("u0")).toBe(false);
    expect(got.get("u1")).toEqual(["file:///sent/1-0.jpg"]);
  });

  it("keeps one chat's photos out of another's", () => {
    expect(photosFor(kept, "b", [{ id: "x", text: "look" }]).get("x")).toEqual(["file:///sent/other.jpg"]);
    expect(photosFor(kept, "c", [{ id: "x", text: "look" }]).size).toBe(0);
  });
});
