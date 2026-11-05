import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { HostedProviders } from "./HostedProviders";
import type { HostedProvider } from "../types";

const provider = (id: string, name: string, connected = false): HostedProvider => ({
  id,
  name,
  url: `https://api.${id}.test/anthropic`,
  models: [`${id}-big`, `${id}-small`],
  key_hint: "sk-…",
  key_page: `https://${id}.test/keys`,
  endpoint_id: connected ? id : null,
  connected,
});

let calls: [string, Record<string, unknown>][] = [];
let list: HostedProvider[];
let fail: string | null = null;

beforeEach(() => {
  clearMocks();
  calls = [];
  fail = null;
  list = [provider("deepseek", "DeepSeek"), provider("other", "Other Co")];
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push([cmd, a]);
    if (cmd === "hosted_provider_list") return list;
    if (cmd === "hosted_provider_connect") {
      if (fail) return Promise.reject(fail);
      return (list = list.map((p) => (p.id === a.id ? { ...p, connected: true, endpoint_id: p.id } : p)));
    }
    if (cmd === "hosted_provider_disconnect") return (list = list.map((p) => (p.id === a.id ? { ...p, connected: false } : p)));
    return null;
  });
});
afterEach(cleanup);

describe("HostedProviders", () => {
  it("shows a row for every provider the backend lists, each with its own key field", async () => {
    render(<HostedProviders />);
    expect(await screen.findByLabelText("DeepSeek API key")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Other Co API key")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Connect" })).toHaveLength(2);
  });

  it("connects one with the key typed, clears the field, says the window should refresh, and never reads the key back", async () => {
    const onChanged = vi.fn();
    render(<HostedProviders onChanged={onChanged} />);
    fireEvent.change(await screen.findByLabelText("DeepSeek API key"), { target: { value: "sk-SECRETSECRET1" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Connect" })[0]);
    await waitFor(() => expect(screen.getByText(/Connected: a key is saved/)).toBeInTheDocument());
    expect(calls.filter(([c]) => c === "hosted_provider_connect").map(([, a]) => a)).toEqual([{ id: "deepseek", key: "sk-SECRETSECRET1" }]);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.queryByDisplayValue("sk-SECRETSECRET1")).toBeNull();
    expect(screen.getByLabelText("Other Co API key")).toHaveValue("");
  });

  it("shows the reason a key was refused and stays unconnected", async () => {
    fail = "That's too short to be an API key.";
    const onChanged = vi.fn();
    render(<HostedProviders onChanged={onChanged} />);
    fireEvent.change(await screen.findByLabelText("DeepSeek API key"), { target: { value: "short-key" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Connect" })[0]);
    expect(await screen.findByRole("alert")).toHaveTextContent("too short");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("removes a connected provider's key", async () => {
    list = [provider("deepseek", "DeepSeek", true)];
    render(<HostedProviders />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove key" }));
    await waitFor(() => expect(screen.getByLabelText("DeepSeek API key")).toBeInTheDocument());
    expect(calls.some(([c, a]) => c === "hosted_provider_disconnect" && a.id === "deepseek")).toBe(true);
  });
});
