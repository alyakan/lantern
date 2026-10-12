import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { api } from "../api";
import { SummaryExport } from "./SummaryExport";

vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("../api", () => ({ api: { exportText: vi.fn() } }));

const exportText = vi.mocked(api.exportText);
const reveal = vi.mocked(revealItemInDir);
const writeText = vi.fn();

const markdown = vi.fn((results: boolean) => (results ? "# Plan\n\nwith results\n" : "# Plan\n"));
const menu = () => fireEvent.click(screen.getByRole("button", { name: /Export/ }));
const show = () => render(<SummaryExport markdown={markdown} fileName="acme-plan-2026-10-12.md" />);

describe("SummaryExport", () => {
  beforeEach(() => {
    localStorage.clear();
    markdown.mockClear();
    exportText.mockReset().mockResolvedValue("/Users/you/Desktop/plan.md");
    reveal.mockReset();
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
  });

  it("copies the document, with what each step did unless that's turned off, and says so", async () => {
    show();
    menu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy as Markdown" }));
    await screen.findByText("Copied");
    expect(writeText).toHaveBeenLastCalledWith("# Plan\n\nwith results\n");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    menu();
    const include = screen.getByRole("menuitemcheckbox", { name: /Include what each step did/ });
    expect(include).toHaveAttribute("aria-checked", "true");
    fireEvent.click(include);
    // The menu stays open for the choice, which is kept for next time.
    expect(screen.getByRole("menuitemcheckbox", { name: /Include/ })).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy as Markdown" }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("# Plan\n"));
    expect(localStorage.getItem("summary.exportResults")).toBe("false");
  });

  it("saves the document where the save dialog says, offers the file's name, and can show it in Finder", async () => {
    show();
    menu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Save as Markdown…" }));
    await screen.findByText(/Saved plan\.md/);
    expect(exportText).toHaveBeenCalledWith("acme-plan-2026-10-12.md", "# Plan\n\nwith results\n");
    fireEvent.click(screen.getByRole("button", { name: "Show in Finder" }));
    expect(reveal).toHaveBeenCalledWith("/Users/you/Desktop/plan.md");
  });

  it("says nothing when the dialog is cancelled, and shows why a save failed", async () => {
    exportText.mockResolvedValueOnce(null);
    show();
    menu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Save as Markdown…" }));
    await waitFor(() => expect(exportText).toHaveBeenCalled());
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    exportText.mockRejectedValueOnce("An export is saved as a .md file.");
    menu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Save as Markdown…" }));
    expect(await screen.findByRole("status")).toHaveTextContent("An export is saved as a .md file.");
  });

  it("moves between its items with the arrow keys, and gives focus back to Export when it closes", () => {
    show();
    const exportButton = screen.getByRole("button", { name: /Export/ });
    menu();
    const copy = screen.getByRole("menuitem", { name: "Copy as Markdown" });
    // The first item, though the checkbox below is on: only a chosen radio or option takes focus on open.
    expect(copy).toHaveFocus();
    fireEvent.keyDown(copy, { key: "ArrowDown" });
    expect(screen.getByRole("menuitem", { name: "Save as Markdown…" })).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Save as Markdown…" }), { key: "End" });
    const include = screen.getByRole("menuitemcheckbox", { name: /Include what each step did/ });
    expect(include).toHaveFocus();
    fireEvent.keyDown(include, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(exportButton).toHaveFocus();
  });

  it("closes the menu on Escape", () => {
    show();
    menu();
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
