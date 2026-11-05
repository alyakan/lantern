import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { HermesSettings } from "./HermesSettings";
import type { HermesStatus } from "../types";

let status: HermesStatus;
let fail: string | null = null;
let calls: [string, Record<string, unknown>][] = [];

beforeEach(() => {
  clearMocks();
  calls = [];
  fail = null;
  status = { installed: true, on: false };
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push([cmd, a]);
    if (cmd === "hermes_status") return status;
    if (cmd === "hermes_set") return fail ? Promise.reject(fail) : (status = { installed: true, on: Boolean(a.on) });
    return null;
  });
});
afterEach(cleanup);

describe("Hermes on the Claude subscription", () => {
  it("isn't shown when Hermes isn't installed", async () => {
    status = { installed: false, on: false };
    const { container } = render(<HermesSettings />);
    await waitFor(() => expect(calls.some(([c]) => c === "hermes_status")).toBe(true));
    expect(container).toBeEmptyDOMElement();
  });

  it("turns the plugin on and off with one switch", async () => {
    render(<HermesSettings />);
    const box = await screen.findByRole("checkbox", { name: /Run Hermes on my Claude subscription/ });
    expect(box).not.toBeChecked();
    fireEvent.click(box);
    await waitFor(() => expect(box).toBeChecked());
    expect(calls).toContainEqual(["hermes_set", { on: true }]);
    fireEvent.click(box);
    await waitFor(() => expect(box).not.toBeChecked());
  });

  it("says what went wrong and stays as it was", async () => {
    fail = "hermes plugins install claude-subscription-directsdk --enable failed: no network";
    render(<HermesSettings />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /Run Hermes/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("no network");
    expect(screen.getByRole("checkbox", { name: /Run Hermes/ })).not.toBeChecked();
  });
});
