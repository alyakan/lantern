import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { api } from "../api";
import { PrChecksDialog } from "./PrChecksDialog";
import { PrChecksSettings } from "./PrChecksSettings";

vi.mock("../api", () => ({ api: { ghAccess: vi.fn() } }));
const ghAccess = vi.mocked(api.ghAccess);

beforeEach(() => {
  vi.resetAllMocks();
  ghAccess.mockResolvedValue("ready");
});
afterEach(cleanup);

function open(setting = { mode: "tell" as const, tries: 3 }) {
  const onSave = vi.fn();
  const onClose = vi.fn();
  render(<PrChecksDialog label="lantern" setting={setting} onSave={onSave} onClose={onClose} />);
  return { onSave, onClose };
}

describe("the Pull request checks dialog", () => {
  it("offers the three choices, each with a plain line, starting on the project's own", () => {
    open();
    const dialog = screen.getByRole("dialog", { name: "Pull request checks" });
    expect(dialog).toHaveTextContent("lantern");
    expect(screen.getByRole("radio", { name: /Off/ })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: /Tell me/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /Fix it myself/ })).not.toBeChecked();
    expect(dialog).toHaveTextContent("Lantern shows how the checks stand, and tells you when one fails.");
    expect(dialog).toHaveTextContent("It never merges.");
  });

  it("has a tries number from 1 to 5 that only Fix it myself uses", () => {
    open();
    const tries = screen.getByRole("combobox", { name: "Tries" }) as HTMLSelectElement;
    expect([...tries.options].map((o) => o.value)).toEqual(["1", "2", "3", "4", "5"]);
    expect(tries.value).toBe("3");
    expect(tries).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: /Fix it myself/ }));
    expect(tries).toBeEnabled();
  });

  it("saves the choice and the tries, then closes", () => {
    const { onSave, onClose } = open();
    fireEvent.click(screen.getByRole("radio", { name: /Fix it myself/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "Tries" }), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledWith({ mode: "fix", tries: 5 });
    expect(onClose).toHaveBeenCalled();
  });

  it("changes nothing on Cancel or Escape", () => {
    const { onSave, onClose } = open();
    fireEvent.click(screen.getByRole("radio", { name: /Off/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("says to install and log in to the GitHub CLI when it can't be used, and not otherwise", async () => {
    ghAccess.mockResolvedValue("missing");
    open();
    expect(await screen.findByRole("note")).toHaveTextContent("Install and log in to the GitHub CLI to watch checks.");
    cleanup();
    ghAccess.mockResolvedValue("ready");
    open();
    await waitFor(() => expect(ghAccess).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("doesn't nag about the GitHub CLI when it is Off", async () => {
    ghAccess.mockResolvedValue("logged_out");
    open({ mode: "off", tries: 3 } as never);
    await waitFor(() => expect(ghAccess).toHaveBeenCalled());
    expect(screen.queryByRole("note")).toBeNull();
  });
});

describe("Settings → Pull requests", () => {
  it("lists every project with its choice, and changes one", () => {
    const onChange = vi.fn();
    render(<PrChecksSettings folders={["/dev/lantern", "/dev/lumiform"]} saved={{ "/dev/lantern": { mode: "fix", tries: 2 } }} onChange={onChange} />);
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByRole("combobox", { name: "After checks run in lantern" })).toHaveValue("fix");
    expect(within(rows[0]).getByRole("combobox", { name: "Tries in lantern" })).toHaveValue("2");
    // The default is Tell me, with no tries to choose.
    expect(within(rows[1]).getByRole("combobox", { name: "After checks run in lumiform" })).toHaveValue("tell");
    expect(within(rows[1]).queryByRole("combobox", { name: /Tries/ })).toBeNull();
    fireEvent.change(within(rows[1]).getByRole("combobox", { name: "After checks run in lumiform" }), { target: { value: "off" } });
    expect(onChange).toHaveBeenCalledWith("/dev/lumiform", { mode: "off", tries: 3 });
    fireEvent.change(within(rows[0]).getByRole("combobox", { name: "Tries in lantern" }), { target: { value: "4" } });
    expect(onChange).toHaveBeenCalledWith("/dev/lantern", { mode: "fix", tries: 4 });
  });

  it("tells projects of the same name apart", () => {
    render(<PrChecksSettings folders={["/a/app", "/b/app"]} saved={{}} onChange={vi.fn()} />);
    expect(screen.getByRole("combobox", { name: "After checks run in app · a" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "After checks run in app · b" })).toBeInTheDocument();
  });
});
