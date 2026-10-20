import { describe, expect, it } from "vitest";
import { phonesLabel } from "../components/TopBar";
import { connectedNames, type RemoteView } from "./remoteControl";

describe("who is connected", () => {
  const view: RemoteView = {
    enabled: true,
    show_titles: false,
    devices: [
      { id: "a", name: "Aly's iPhone", paired_at: 0, last_seen: 0 },
      { id: "b", name: "Pixel", paired_at: 0, last_seen: 0 },
    ],
    connected: ["b"],
  };

  it("names the paired phones that are connected now", () => {
    expect(connectedNames(view)).toEqual(["Pixel"]);
    expect(connectedNames({ ...view, connected: [] })).toEqual([]);
  });

  it("says one phone by its name and more by their count", () => {
    expect(phonesLabel(["Aly's iPhone"])).toBe("Aly's iPhone is connected");
    expect(phonesLabel(["a", "b"])).toBe("2 phones are connected");
  });
});
