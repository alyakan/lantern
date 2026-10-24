import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { keyIdFromFile, lastSeen, LANTERN_TEAM_ID, timeLeft, type RemoteView } from "../lib/remoteControl";

const calls: { cmd: string; args?: unknown }[] = [];
let view: RemoteView;
let changed: () => void = () => {};
let picked: string | null = null;
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: () => Promise.resolve(picked) }));
vi.mock("../api", () => ({
  api: {
    remoteSetLiveKey: (path: string, keyId: string, teamId: string) => {
      calls.push({ cmd: "livekey", args: [path, keyId, teamId] });
      if (keyId === "BADKEY0000") return Promise.reject("That isn't a push key: it should be the .p8 file Apple gave you.");
      view = { ...view, live_key: keyId };
      return Promise.resolve(view);
    },
    remoteSettings: () => Promise.resolve(view),
    onRemoteChanged: (cb: () => void) => {
      changed = cb;
      return Promise.resolve(() => {});
    },
    remoteSetEnabled: (on: boolean) => {
      calls.push({ cmd: "enabled", args: on });
      view = { ...view, enabled: on, listening: on };
      return Promise.resolve(view);
    },
    remoteSetShowTitles: (on: boolean) => {
      calls.push({ cmd: "titles", args: on });
      view = { ...view, show_titles: on };
      return Promise.resolve(view);
    },
    remoteSetKeepAwake: (on: boolean) => {
      calls.push({ cmd: "awake", args: on });
      view = { ...view, keep_awake: on };
      return Promise.resolve(view);
    },
    remoteSetAllowAuto: (on: boolean) => {
      calls.push({ cmd: "auto", args: on });
      view = { ...view, allow_phone_auto: on };
      return Promise.resolve(view);
    },
    remotePair: () => {
      if (!view.enabled) return Promise.reject("Turn on Remote control first.");
      view = { ...view, pairing: true };
      return Promise.resolve({ svg: "<svg/>", link: "lantern://pair?v=1&test", expires_at: 300_000 });
    },
    remotePairCancel: () => {
      calls.push({ cmd: "cancel" });
      return Promise.resolve();
    },
    remoteRemoveDevice: (id: string) => {
      calls.push({ cmd: "remove", args: id });
      view = { ...view, devices: view.devices.filter((d) => d.id !== id) };
      return Promise.resolve(view);
    },
  },
}));

const { RemoteControl } = await import("./RemoteControl");

beforeEach(() => {
  calls.length = 0;
  picked = null;
  view = { enabled: false, show_titles: false, keep_awake: false, tailnet: [], allow_phone_auto: false, devices: [], connected: [], listening: false, pairing: false };
});

describe("Settings › Remote control", () => {
  it("starts off, with nothing to pair until it is turned on", async () => {
    render(<RemoteControl now={() => 0} />);
    const on = await screen.findByRole("checkbox", { name: "Let paired phones control Lantern" });
    expect(on).not.toBeChecked();
    expect(screen.queryByText("Show a pairing code")).toBeNull();
    fireEvent.click(on);
    await screen.findByText("Show a pairing code");
    expect(calls).toContainEqual({ cmd: "enabled", args: true });
  });

  it("shows a pairing code as an image with its time left, and stopping or leaving ends it", async () => {
    view = { ...view, enabled: true, listening: true };
    const { unmount } = render(<RemoteControl now={() => 8_000} />);
    fireEvent.click(await screen.findByText("Show a pairing code"));
    const img = await screen.findByRole("img", { name: "Pairing code" });
    expect(img.getAttribute("src")).toBe(`data:image/svg+xml;utf8,${encodeURIComponent("<svg/>")}`);
    expect(screen.getByText(/stops working in 4:52/)).toBeTruthy();
    fireEvent.click(screen.getByText("Stop pairing"));
    expect(screen.queryByRole("img", { name: "Pairing code" })).toBeNull();
    expect(calls).toContainEqual({ cmd: "cancel" });
    calls.length = 0;
    unmount();
    expect(calls).toContainEqual({ cmd: "cancel" });
  });

  it("copies the pairing link, and says so", async () => {
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", { value: { writeText: (t: string) => (written.push(t), Promise.resolve()) }, configurable: true });
    view = { ...view, enabled: true, listening: true };
    render(<RemoteControl now={() => 0} />);
    fireEvent.click(await screen.findByText("Show a pairing code"));
    fireEvent.click(await screen.findByText("Copy the link"));
    await screen.findByText("Copied");
    expect(written).toEqual(["lantern://pair?v=1&test"]);
  });

  it("says when the link couldn't be copied", async () => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject("not allowed") }, configurable: true });
    view = { ...view, enabled: true, listening: true };
    render(<RemoteControl now={() => 0} />);
    fireEvent.click(await screen.findByText("Show a pairing code"));
    fireEvent.click(await screen.findByText("Copy the link"));
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't copy the link: not allowed");
  });

  it("takes a code away once it was used, and offers a new one", async () => {
    view = { ...view, enabled: true, listening: true };
    render(<RemoteControl now={() => 0} />);
    fireEvent.click(await screen.findByText("Show a pairing code"));
    await screen.findByRole("img", { name: "Pairing code" });
    view = { ...view, pairing: false };
    await act(async () => changed());
    expect(screen.queryByRole("img", { name: "Pairing code" })).toBeNull();
    expect(screen.getByText(/That code was used/)).toBeTruthy();
    expect(screen.getByText("Show a new code")).toBeTruthy();
  });

  it("says where to look when a phone can't connect: the firewall, which silently ignores a Mac it hasn't allowed", async () => {
    view = { ...view, enabled: true, listening: true };
    render(<RemoteControl now={() => 0} />);
    expect(await screen.findByText(/System Settings › Network › Firewall/)).toBeTruthy();
  });

  it("says so when it's on but nothing is listening", async () => {
    view = { ...view, enabled: true, listening: false };
    render(<RemoteControl now={() => 0} />);
    expect((await screen.findByRole("status")).textContent).toContain("isn't listening");
  });

  it("turning it off takes the code away", async () => {
    view = { ...view, enabled: true, listening: true };
    render(<RemoteControl now={() => 0} />);
    fireEvent.click(await screen.findByText("Show a pairing code"));
    await screen.findByRole("img", { name: "Pairing code" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Let paired phones control Lantern" }));
    await waitFor(() => expect(screen.queryByRole("img", { name: "Pairing code" })).toBeNull());
  });

  it("lists paired phones and removes one", async () => {
    view.devices = [{ id: "phone-1", name: "Aly's iPhone", paired_at: 0, last_seen: 0 }];
    render(<RemoteControl now={() => 3 * 86_400_000} />);
    expect(await screen.findByText("Aly's iPhone")).toBeTruthy();
    expect(screen.getByText(/Last connected 3 days ago/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove Aly's iPhone" })));
    expect(calls).toContainEqual({ cmd: "remove", args: "phone-1" });
    expect(screen.getByText("No phones yet.")).toBeTruthy();
  });

  it("says so when a change holds but couldn't be saved", async () => {
    view.devices = [{ id: "phone-1", name: "Pixel", paired_at: 0, last_seen: null }];
    render(<RemoteControl now={() => 0} />);
    await screen.findByText("Pixel");
    const removed = { ...view, devices: [], warning: "Done for now, but Lantern couldn't save it, so it won't last past a restart: disk full" };
    view = removed;
    const { api } = await import("../api");
    vi.spyOn(api, "remoteRemoveDevice").mockResolvedValueOnce(removed);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Remove Pixel" })));
    expect(screen.getByRole("alert").textContent).toContain("won't last past a restart");
    expect(screen.getByText("No phones yet.")).toBeTruthy();
  });

  it("says the Mac's Tailscale address when Tailscale is on, and how to get it when it isn't", async () => {
    view = { ...view, enabled: true, listening: true, tailnet: ["100.101.102.103"] };
    const { unmount } = render(<RemoteControl now={() => 0} />);
    expect((await screen.findByText(/Tailscale is on/)).textContent).toContain("100.101.102.103");
    unmount();
    view = { ...view, tailnet: [] };
    render(<RemoteControl now={() => 0} />);
    expect(await screen.findByText(/Tailscale isn't on this Mac/)).toBeTruthy();
  });

  it("offers keeping the Mac awake only while Remote control is on, and it starts off", async () => {
    const { unmount } = render(<RemoteControl now={() => 0} />);
    await screen.findByRole("checkbox", { name: "Let paired phones control Lantern" });
    expect(screen.queryByRole("checkbox", { name: "Keep this Mac awake while Remote control is on" })).toBeNull();
    unmount();
    view = { ...view, enabled: true, listening: true };
    render(<RemoteControl now={() => 0} />);
    const awake = await screen.findByRole("checkbox", { name: "Keep this Mac awake while Remote control is on" });
    expect(awake).not.toBeChecked();
    fireEvent.click(awake);
    await waitFor(() => expect(calls).toContainEqual({ cmd: "awake", args: true }));
  });

  it("Auto from a phone is off until turned on, and says that chats already on Auto stay there when it is turned off", async () => {
    render(<RemoteControl now={() => 0} />);
    const auto = await screen.findByRole("checkbox", { name: "Let paired phones use Auto" });
    expect(auto).not.toBeChecked();
    expect(screen.getByText(/Turning it off doesn't change chats already on Auto/)).toBeTruthy();
    fireEvent.click(auto);
    await waitFor(() => expect(calls).toContainEqual({ cmd: "auto", args: true }));
  });

  it("chat titles in notifications are off until turned on", async () => {
    render(<RemoteControl now={() => 0} />);
    const titles = await screen.findByRole("checkbox", { name: "Show chat titles in notifications" });
    expect(titles).not.toBeChecked();
    fireEvent.click(titles);
    await waitFor(() => expect(calls).toContainEqual({ cmd: "titles", args: true }));
  });
});

describe("the words for time", () => {
  it("counts a code down in minutes and seconds, never below zero", () => {
    expect(timeLeft(300_000, 8_000)).toBe("4:52");
    expect(timeLeft(1_000, 5_000)).toBe("0:00");
  });

  it("says when a phone last connected", () => {
    expect(lastSeen(null, 0)).toBe("Never connected");
    expect(lastSeen(0, 60_000)).toBe("Connected just now");
    expect(lastSeen(0, 5 * 60_000)).toBe("Last connected 5 minutes ago");
    expect(lastSeen(0, 3_600_000)).toBe("Last connected 1 hour ago");
    expect(lastSeen(0, 2 * 86_400_000)).toBe("Last connected 2 days ago");
  });
});

describe("Settings › Remote control › lock screen cards", () => {
  it("reads the Key ID from the name Apple gives the file, and from no other", () => {
    expect(keyIdFromFile("/Users/me/Downloads/AuthKey_LUF3H7H4S4.p8")).toBe("LUF3H7H4S4");
    expect(keyIdFromFile("C:\\keys\\AuthKey_LUF3H7H4S4.p8")).toBe("LUF3H7H4S4");
    for (const other of ["/k/key.p8", "/k/AuthKey_short.p8", "/k/AuthKey_LUF3H7H4S4.p8.txt", "/k/MyAuthKey_LUF3H7H4S4.p8", ""]) expect(keyIdFromFile(other)).toBeNull();
  });

  it("says there is no key yet, imports the one chosen with its Key ID filled in, and then names it", async () => {
    render(<RemoteControl now={() => 0} />);
    expect((await screen.findByText(/No push key yet/)).textContent).toContain("no card is kept up to date");
    picked = "/Users/me/Downloads/AuthKey_LUF3H7H4S4.p8";
    fireEvent.click(screen.getByText("Import the push key…"));
    const keyId = (await screen.findByLabelText("Key ID")) as HTMLInputElement;
    expect(keyId.value).toBe("LUF3H7H4S4");
    expect((screen.getByLabelText("Team ID") as HTMLInputElement).value).toBe(LANTERN_TEAM_ID);
    fireEvent.click(screen.getByText("Import"));
    await screen.findByText("Push key: LUF3H7H4S4");
    expect(calls).toContainEqual({ cmd: "livekey", args: ["/Users/me/Downloads/AuthKey_LUF3H7H4S4.p8", "LUF3H7H4S4", LANTERN_TEAM_ID] });
    expect(screen.queryByLabelText("Key ID")).toBeNull();
    expect(screen.getByText("Replace the push key…")).toBeTruthy();
  });

  it("lets the ids be corrected, and says why when the key isn't taken, without importing anything", async () => {
    render(<RemoteControl now={() => 0} />);
    picked = "/k/some-name.p8";
    fireEvent.click(await screen.findByText("Import the push key…"));
    const keyId = (await screen.findByLabelText("Key ID")) as HTMLInputElement;
    expect(keyId.value).toBe("");
    fireEvent.change(keyId, { target: { value: "BADKEY0000" } });
    fireEvent.click(screen.getByText("Import"));
    expect((await screen.findByRole("alert")).textContent).toContain("That isn't a push key");
    expect(screen.queryByText(/Push key: /)).toBeNull();
  });

  it("does nothing when the file dialog is closed, and cancelling the form changes nothing", async () => {
    render(<RemoteControl now={() => 0} />);
    fireEvent.click(await screen.findByText("Import the push key…"));
    await waitFor(() => expect(screen.queryByLabelText("Key ID")).toBeNull());
    picked = "/k/AuthKey_LUF3H7H4S4.p8";
    fireEvent.click(screen.getByText("Import the push key…"));
    await screen.findByLabelText("Key ID");
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByLabelText("Key ID")).toBeNull();
    expect(calls.filter((c) => c.cmd === "livekey")).toEqual([]);
  });

  it("shows what Apple last said, and never anything else about a push", async () => {
    view = { ...view, live_key: "LUF3H7H4S4", live_last: "Apple answered 403 (InvalidProviderToken)." };
    render(<RemoteControl now={() => 0} />);
    expect(await screen.findByText("Apple last said: Apple answered 403 (InvalidProviderToken).")).toBeTruthy();
  });
});
