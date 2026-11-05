import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { ApiKeysSettings } from "./ApiKeysSettings";

type Auth = { claude: { use_key: boolean; has_key: boolean }; endpoint_keys: string[]; not_yet: string };
let calls: [string, Record<string, unknown>][] = [];
let auth: Auth;
let fail: Record<string, string> = {};

const backend = () =>
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push([cmd, a]);
    if (fail[cmd]) return Promise.reject(fail[cmd]);
    if (cmd === "provider_auth_state") return auth;
    if (cmd === "provider_claude_key_set") return (auth = { ...auth, claude: { ...auth.claude, has_key: true } });
    if (cmd === "provider_claude_key_clear") return (auth = { ...auth, claude: { use_key: false, has_key: false } });
    if (cmd === "provider_claude_use_key") return (auth = { ...auth, claude: { ...auth.claude, use_key: a.on as boolean } });
    return null;
  });
const sent = (cmd: string) => calls.filter(([c]) => c === cmd).map(([, a]) => a);

beforeEach(() => {
  clearMocks();
  calls = [];
  fail = {};
  auth = { claude: { use_key: false, has_key: false }, endpoint_keys: [], not_yet: "Codex's own sign-in is used for now: reasons." };
});
afterEach(cleanup);

describe("Settings → API keys", () => {
  it("starts on the sign-in, offers a key field, and can't be put on the key before one is saved", async () => {
    backend();
    render(<ApiKeysSettings />);
    expect(await screen.findByLabelText("Anthropic API key")).toHaveAttribute("type", "password");
    expect(screen.getByRole("radio", { name: /Its own sign-in/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /My API key/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save key" })).toBeDisabled();
  });

  it("saves the key typed, clears the field, shows only that one is saved, and never asks the backend for it back", async () => {
    backend();
    render(<ApiKeysSettings />);
    fireEvent.change(await screen.findByLabelText("Anthropic API key"), { target: { value: "sk-ant-api03-SECRETSECRET" } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    expect(await screen.findByText("A key is saved in your Mac's Keychain.")).toBeInTheDocument();
    expect(sent("provider_claude_key_set")).toEqual([{ key: "sk-ant-api03-SECRETSECRET" }]);
    // The key is not on the page any more, in a field or as text.
    expect(screen.queryByLabelText("Anthropic API key")).toBeNull();
    expect(document.body.textContent).not.toContain("SECRETSECRET");
    expect(screen.getByRole("radio", { name: /My API key/ })).toBeEnabled();
  });

  it("turns the key on and back off, and removing the key puts it back on the sign-in", async () => {
    auth = { ...auth, claude: { use_key: false, has_key: true } };
    backend();
    render(<ApiKeysSettings />);
    fireEvent.click(await screen.findByRole("radio", { name: /My API key/ }));
    await waitFor(() => expect(sent("provider_claude_use_key")).toEqual([{ on: true }]));
    await waitFor(() => expect(screen.getByRole("radio", { name: /My API key/ })).toBeChecked());
    fireEvent.click(screen.getByRole("button", { name: "Remove key" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: /Its own sign-in/ })).toBeChecked());
    expect(screen.getByLabelText("Anthropic API key")).toBeInTheDocument();
  });

  it("says why a key was refused, keeping what was typed", async () => {
    fail.provider_claude_key_set = "That's too short to be an API key.";
    backend();
    render(<ApiKeysSettings />);
    fireEvent.change(await screen.findByLabelText("Anthropic API key"), { target: { value: "abcdefgh" } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("too short");
    expect(screen.getByLabelText("Anthropic API key")).toHaveValue("abcdefgh");
  });

  it("says what a key means: where it goes, who can read it, what is lost, and that it never falls back to the sign-in", async () => {
    backend();
    render(<ApiKeysSettings />);
    await screen.findByLabelText("Anthropic API key");
    expect(screen.getByText(/bills your API account and not a subscription/)).toBeInTheDocument();
    expect(screen.getByText(/commands Claude runs in a chat can read it/)).toBeInTheDocument();
    expect(screen.getByText(/Use a key with a spending limit/)).toBeInTheDocument();
    expect(screen.getByText(/doesn't load your claude.ai connectors/)).toBeInTheDocument();
    expect(screen.getByText(/never falls back to your sign-in/)).toBeInTheDocument();
    expect(screen.getByText(/already running keeps what it started with/)).toBeInTheDocument();
  });

  it("says why Codex has no key yet, and where an endpoint's key goes", async () => {
    backend();
    render(<ApiKeysSettings />);
    expect(await screen.findByText("Codex's own sign-in is used for now: reasons.")).toBeInTheDocument();
    expect(screen.getByText(/set on the endpoint itself, in Endpoints/)).toBeInTheDocument();
  });
});
