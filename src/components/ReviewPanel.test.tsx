import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ReviewPanel } from "./ReviewPanel";

vi.mock("./FullDiff", () => ({ default: ({ path }: { path: string }) => <div>diff of {path}</div> }));

const files = [
  { path: "/p/src/a.ts", created: false, added: 3, removed: 1 },
  { path: "/p/src/b.ts", created: true, added: 9, removed: 0 },
];
const base = { folder: "/p", ready: false, files, refreshKey: 0, onSelect: () => {}, onFollow: () => {} };

describe("ReviewPanel", () => {
  it("shows an empty state", () => {
    render(<ReviewPanel {...base} files={[]} selected={null} follow />);
    expect(screen.getByText("No changes yet")).toBeInTheDocument();
  });

  it("shows the selected file with position and navigates", async () => {
    const onSelect = vi.fn();
    render(<ReviewPanel {...base} selected="/p/src/a.ts" follow onSelect={onSelect} />);
    expect(await screen.findByText("diff of /p/src/a.ts")).toBeInTheDocument();
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous file" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next file" }));
    expect(onSelect).toHaveBeenCalledWith("/p/src/b.ts");
    expect(screen.queryByText("↓ Latest")).toBeNull();
  });

  // The filter is a menu: its button names the current choice; the options say what each one means.
  const filterButton = () => screen.getByRole("button", { name: /^Show changes from/ });
  const openFilter = () => fireEvent.click(filterButton());
  const option = (name: string | RegExp) => screen.getByRole("menuitemradio", { name });

  it("filters between the last turn's changes and the whole session's", () => {
    const onScope = vi.fn();
    const { rerender } = render(<ReviewPanel {...base} scope="session" onScope={onScope} scopeCounts={{ turn: 1, session: 2, git: null }} selected="/p/src/a.ts" follow />);
    expect(filterButton()).toHaveTextContent("Session2");
    openFilter();
    expect(option(/^Session/)).toHaveAttribute("aria-checked", "true");
    expect(option(/^Last turn/)).toHaveAttribute("aria-checked", "false");
    expect(option(/^Last turn/)).toHaveTextContent("What changed since your last message");
    fireEvent.click(option(/^Last turn/));
    expect(onScope).toHaveBeenCalledWith("turn");
    expect(screen.queryByRole("menu")).toBeNull();
    rerender(<ReviewPanel {...base} files={[]} scope="turn" onScope={onScope} selected={null} follow />);
    expect(screen.getByText("No changes in the last turn")).toBeInTheDocument();
    expect(filterButton()).toHaveTextContent("Last turn");
  });

  it("offers what's uncommitted, and says why when there's none to show", () => {
    const onScope = vi.fn();
    const { rerender } = render(<ReviewPanel {...base} scope="session" onScope={onScope} scopeCounts={{ turn: 0, session: 2, git: 5 }} selected="/p/src/a.ts" follow />);
    openFilter();
    expect(option(/^Uncommitted/)).toHaveTextContent("Uncommitted5Everything not committed yet");
    fireEvent.click(option(/^Uncommitted/));
    expect(onScope).toHaveBeenCalledWith("git");
    rerender(<ReviewPanel {...base} files={[]} scope="git" onScope={onScope} gitError="This folder isn't in a git repository." selected={null} follow />);
    expect(screen.getByText("This folder isn't in a git repository.")).toBeInTheDocument();
    rerender(<ReviewPanel {...base} files={[]} scope="git" onScope={onScope} selected={null} follow />);
    expect(screen.getByText("Nothing uncommitted")).toBeInTheDocument();
  });

  it("offers a reviewed PR's files, first among the filters, and says while it's fetching", () => {
    const onScope = vi.fn();
    const { rerender } = render(<ReviewPanel {...base} scope="session" onScope={onScope} pr={128} scopeCounts={{ pr: 2 }} selected="/p/src/a.ts" follow />);
    openFilter();
    expect(screen.getAllByRole("menuitemradio")[0]).toHaveTextContent(/^PR #1282/);
    fireEvent.click(option(/^PR #128/));
    expect(onScope).toHaveBeenCalledWith("pr");
    rerender(<ReviewPanel {...base} files={[]} scope="pr" onScope={onScope} pr={128} selected={null} follow />);
    expect(screen.getByText("Fetching pull request #128…")).toBeInTheDocument();
    rerender(<ReviewPanel {...base} files={[]} scope="pr" onScope={onScope} pr={128} gitError="gh pr view: no pull requests found" selected={null} follow />);
    expect(screen.getByText("gh pr view: no pull requests found")).toBeInTheDocument();
    rerender(<ReviewPanel {...base} scope="session" onScope={onScope} selected="/p/src/a.ts" follow />);
    openFilter();
    expect(screen.queryByRole("menuitemradio", { name: /PR/ })).toBeNull();
  });

  it("offers a local branch's files, with its commits above the diff", () => {
    const branch = { branch: "feat/x", base: "origin/main", commits: [{ sha: "a41c9e2", subject: "test: retries", author: "Sam", at: Date.now() - 60_000 }] };
    render(<ReviewPanel {...base} scope="branch" onScope={() => {}} branch={branch} scopeCounts={{ branch: 2 }} selected="/p/src/a.ts" follow />);
    expect(filterButton()).toHaveTextContent("This branch2");
    openFilter();
    expect(screen.getAllByRole("menuitemradio")[0]).toHaveTextContent("Committed on feat/x since it left origin/main");
    expect(screen.getByText(/1 commit on/)).toHaveTextContent("1 commit on feat/x since origin/main");
    expect(screen.getByText("test: retries")).toBeInTheDocument();
  });

  it("picks a file from the dropdown", () => {
    const onSelect = vi.fn();
    render(<ReviewPanel {...base} selected="/p/src/a.ts" follow={false} onSelect={onSelect} />);
    fireEvent.click(screen.getByRole("button", { name: /src\/a\.ts/ }));
    fireEvent.click(screen.getByRole("option", { name: /b\.ts/ }).querySelector("button")!);
    expect(onSelect).toHaveBeenCalledWith("/p/src/b.ts");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("offers to follow again after a manual selection", () => {
    const onFollow = vi.fn();
    render(<ReviewPanel {...base} selected="/p/src/a.ts" follow={false} onFollow={onFollow} />);
    fireEvent.click(screen.getByText("↓ Latest"));
    expect(onFollow).toHaveBeenCalled();
  });
});
