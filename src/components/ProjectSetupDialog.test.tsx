import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { ProjectSetupDialog } from "./ProjectSetupDialog";

vi.mock("../api", () => ({ api: { suggestSetup: vi.fn() } }));

beforeEach(() => vi.mocked(api.suggestSetup).mockReset().mockResolvedValue({ commands: [], run: null }));
afterEach(cleanup);

const show = (saved?: { commands: string[]; run: string }) => {
  const onSave = vi.fn();
  const onClose = vi.fn();
  render(<ProjectSetupDialog folder="/Users/you/dev/acme-api" saved={saved} onSave={onSave} onClose={onClose} />);
  return { onSave, onClose };
};
const lines = () => screen.getByRole("textbox", { name: /Run in each new agent's worktree/ }) as HTMLTextAreaElement;
const run = () => screen.getByRole("textbox", { name: /Run command/ }) as HTMLInputElement;

describe("the project setup dialog", () => {
  it("names the project and starts from what was saved", () => {
    show({ commands: ["npm ci", "cp ../x ."], run: "npm run dev" });
    expect(screen.getByText("Project setup for acme-api")).toBeTruthy();
    expect(lines().value).toBe("npm ci\ncp ../x .");
    expect(run().value).toBe("npm run dev");
  });

  it("saves what was typed as trimmed lines, leaving blank ones out", () => {
    const { onSave, onClose } = show();
    fireEvent.change(lines(), { target: { value: "  npm ci \n\n  cp a b  \n" } });
    fireEvent.change(run(), { target: { value: " npm run dev " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({ commands: ["npm ci", "cp a b"], run: "npm run dev" });
    expect(onClose).toHaveBeenCalled();
  });

  it("saves nothing when cancelled or closed with Escape", () => {
    const { onSave, onClose } = show();
    fireEvent.change(lines(), { target: { value: "rm -rf /" } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent(document.querySelector("dialog")!, new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("refuses too many lines, and says why", () => {
    const { onSave } = show();
    fireEvent.change(lines(), { target: { value: Array(25).fill("echo hi").join("\n") } });
    expect(screen.getByRole("alert").textContent).toMatch(/at most 20 lines/);
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.submit(save.closest("form")!);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("explains that only lines written here run, and that $LANTERN_PROJECT_DIR is the user's own folder", () => {
    show();
    expect(screen.getByText(/Lantern never reads them from a file in your project/)).toBeTruthy();
    expect(screen.getAllByText("$LANTERN_PROJECT_DIR").length).toBeGreaterThan(0);
  });
});

describe("what the project's files suggest", () => {
  it("is offered, and only fills the boxes: nothing is saved until Save", async () => {
    vi.mocked(api.suggestSetup).mockResolvedValue({ commands: ["pnpm install --frozen-lockfile"], run: "pnpm run dev" });
    const { onSave } = show();
    await screen.findByText(/Found in the project/);
    expect(api.suggestSetup).toHaveBeenCalledWith("/Users/you/dev/acme-api");
    expect(lines().value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Fill in" }));
    expect(lines().value).toBe("pnpm install --frozen-lockfile");
    expect(run().value).toBe("pnpm run dev");
    expect(onSave).not.toHaveBeenCalled();
    // What it would fill in is already there: nothing left to offer.
    expect(screen.queryByText(/Found in the project/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({ commands: ["pnpm install --frozen-lockfile"], run: "pnpm run dev" });
  });

  it("fills in only the lines when it found no Run command, keeping what was typed there", async () => {
    vi.mocked(api.suggestSetup).mockResolvedValue({ commands: ["npm ci"], run: null });
    show({ commands: [], run: "make serve" });
    fireEvent.click(await screen.findByRole("button", { name: "Fill in" }));
    expect(lines().value).toBe("npm ci");
    expect(run().value).toBe("make serve");
  });

  it("is not offered when the project suggests nothing, or the lookup fails", async () => {
    show();
    await waitFor(() => expect(api.suggestSetup).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Fill in" })).toBeNull();
    cleanup();
    vi.mocked(api.suggestSetup).mockRejectedValueOnce("no");
    show();
    await waitFor(() => expect(api.suggestSetup).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: "Fill in" })).toBeNull();
  });
});
