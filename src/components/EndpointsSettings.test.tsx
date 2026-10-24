import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { EndpointsSettings } from "./EndpointsSettings";

type Saved = { id: string; name: string; url: string; key_env: string | null; models: string[] };
let calls: [string, Record<string, unknown>][] = [];
let listed: (Saved & { key_set: boolean | null })[] = [];
let answers: Record<string, unknown> = {};

const backend = () =>
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push([cmd, a]);
    if (cmd === "list_endpoints") return listed;
    if (cmd === "save_endpoints") return answers.save instanceof Error ? Promise.reject(answers.save.message) : (a.endpoints as Saved[]);
    if (cmd === "fetch_endpoint_models") return answers.fetch instanceof Error ? Promise.reject(answers.fetch.message) : answers.fetch;
    return null;
  });
const sent = (cmd: string) => calls.filter(([c]) => c === cmd).map(([, a]) => a);

beforeEach(() => {
  clearMocks();
  calls = [];
  answers = {};
  listed = [{ id: "ollama", name: "Ollama", url: "http://localhost:11434", key_env: "OLLAMA_API_KEY", models: ["qwen3:8b"], key_set: false }];
});
afterEach(cleanup);

describe("Settings → Endpoints", () => {
  it("lists what is saved, says whether its key variable is set, and offers Save only once something changed", async () => {
    backend();
    render(<EndpointsSettings onSaved={() => {}} />);
    expect(await screen.findByDisplayValue("Ollama")).toBeInTheDocument();
    expect(screen.getByDisplayValue("http://localhost:11434")).toBeInTheDocument();
    expect(screen.getByDisplayValue("qwen3:8b")).toBeInTheDocument();
    expect(screen.getByText("OLLAMA_API_KEY isn't set in your login shell: a chat on this endpoint won't start.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(screen.getByDisplayValue("Ollama"), { target: { value: "Local" } });
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("says it keeps no keys and that a chat on an endpoint sends nothing to Anthropic", async () => {
    backend();
    render(<EndpointsSettings onSaved={() => {}} />);
    await screen.findByDisplayValue("Ollama");
    expect(screen.getByText(/Lantern keeps no keys/)).toBeInTheDocument();
    expect(screen.getByText(/sends nothing to Anthropic/)).toBeInTheDocument();
    expect(screen.getByText(/Anthropic doesn't support non-Claude models in Claude Code/)).toBeInTheDocument();
  });

  it("adds an endpoint from a preset, saves the models as typed (one each, no repeats), and tells the window", async () => {
    listed = [];
    backend();
    const onSaved = vi.fn();
    render(<EndpointsSettings onSaved={onSaved} />);
    expect(await screen.findByText(/No endpoints yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "OpenRouter" }));
    expect(screen.getByDisplayValue("https://openrouter.ai/api")).toBeInTheDocument();
    expect(screen.getByDisplayValue("OPENROUTER_API_KEY")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/^Models/), { target: { value: "openai/gpt-5, anthropic/claude-sonnet-4-5\nopenai/gpt-5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    // The id is the backend's to make; the key is a variable's NAME, and nothing else about a key goes.
    expect(sent("save_endpoints")).toEqual([{ endpoints: [{ id: "", name: "OpenRouter", url: "https://openrouter.ai/api", key_env: "OPENROUTER_API_KEY", models: ["openai/gpt-5", "anthropic/claude-sonnet-4-5"] }] }]);
  });

  it("shows why saving was refused, in the backend's words, and doesn't tell the window", async () => {
    backend();
    answers.save = new Error("A key is only sent over https, or http to this Mac or its own network.");
    const onSaved = vi.fn();
    render(<EndpointsSettings onSaved={onSaved} />);
    fireEvent.change(await screen.findByDisplayValue("http://localhost:11434"), { target: { value: "http://example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("A key is only sent over https");
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("fills the models in from the endpoint, and says why when it can't", async () => {
    backend();
    answers.fetch = ["qwen3:8b", "gpt-oss:20b"];
    render(<EndpointsSettings onSaved={() => {}} />);
    await screen.findByDisplayValue("Ollama");
    fireEvent.click(screen.getByRole("button", { name: "Fetch models" }));
    await waitFor(() => expect((screen.getByLabelText(/^Models/) as HTMLTextAreaElement).value).toBe("qwen3:8b\ngpt-oss:20b"));
    // The key's NAME goes with it (the backend reads the value from the login shell), never a value.
    expect(sent("fetch_endpoint_models")).toEqual([{ url: "http://localhost:11434", keyEnv: "OLLAMA_API_KEY" }]);
    answers.fetch = new Error("Couldn't reach it. Is it running?");
    fireEvent.click(screen.getByRole("button", { name: "Fetch models" }));
    expect(await screen.findByText("Couldn't reach it. Is it running?")).toBeInTheDocument();
    expect((screen.getByLabelText(/^Models/) as HTMLTextAreaElement).value).toBe("qwen3:8b\ngpt-oss:20b");
  });

  it("removes an endpoint from the list, and saves the list without it", async () => {
    backend();
    const onSaved = vi.fn();
    render(<EndpointsSettings onSaved={onSaved} />);
    await screen.findByDisplayValue("Ollama");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.getByText(/No endpoints yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(sent("save_endpoints")).toEqual([{ endpoints: [] }]);
  });
});
