import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary";

let broken = true;
function Pane() {
  if (broken) throw new Error("boom");
  return <p>pane drawn</p>;
}

describe("ErrorBoundary", () => {
  afterEach(() => {
    broken = true;
    vi.restoreAllMocks();
  });

  it("shows a fallback for the pane that crashed, and the other panes keep drawing", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <>
        <ErrorBoundary name="chat">
          <Pane />
        </ErrorBoundary>
        <p>other pane</p>
      </>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong — Reload this chat");
    expect(screen.getByText("other pane")).toBeInTheDocument();
  });

  it("draws the pane again when asked to reload it", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Pane />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("button", { name: "Reload this pane" })).toBeInTheDocument();
    broken = false;
    fireEvent.click(screen.getByRole("button", { name: "Reload this pane" }));
    expect(screen.getByText("pane drawn")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
