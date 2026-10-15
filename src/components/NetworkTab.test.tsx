import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NetworkTab } from "./NetworkTab";
import { api } from "../api";
import type { NetworkDetail, NetworkItem, NetworkTx, NetworkView } from "../types";

vi.mock("../api", () => ({ api: { networkResponse: vi.fn(), networkUnwatch: vi.fn(), networkRewatch: vi.fn() } }));

const tx = (id: string, over: Partial<NetworkTx> = {}): NetworkTx => ({
  id, revision: 1, started_at: Date.now() - 5_000, method: "GET", url: `https://api.x/v1/checklists/${id}`, host: "api.x", path: "/v1/checklists", status: 200, duration_ms: 120,
  state: "completed", error: null, request_content_type: null, response_content_type: "application/json", request_size: 0, response_size: 30, ...over,
});
const item = (id: string, over: Partial<NetworkItem> = {}): NetworkItem => ({ tx: tx(id), watch: "Checklists", summary: null, has_response: true, ...over });
const detail = (t: NetworkTx, body: string): NetworkDetail => ({
  transaction: t,
  request_headers: [{ name: "Accept", value: "application/json" }],
  request_body: { encoding: "utf8", data: "", size: 0, truncated: false },
  response_headers: [{ name: "Content-Type", value: "application/json" }],
  response_body: { encoding: "utf8", data: body, size: body.length, truncated: false },
});
const view = (over: Partial<NetworkView> = {}): NetworkView => ({ link: { status: "connected" }, watches: [{ label: "Checklists", method: "GET", url: "/v1/checklists" }], items: [], ...over });

const responses: Record<string, string> = {
  one: JSON.stringify({ data: [{ id: 1, title: "Fire safety", owner: null }], meta: { total: 41 } }),
  two: JSON.stringify({ error: "not found" }),
};

beforeEach(() => {
  vi.mocked(api.networkResponse).mockImplementation(async (_folder, id) => detail(tx(id), responses[id]));
  vi.mocked(api.networkUnwatch).mockResolvedValue(true);
  vi.mocked(api.networkRewatch).mockResolvedValue(undefined);
});

describe("NetworkTab", () => {
  it("says when nothing matches yet, and when Network Monitor isn't running", () => {
    const { rerender } = render(<NetworkTab folder="/p" view={view()} onSummarize={null} />);
    expect(screen.getByText(/No requests match yet/)).toBeInTheDocument();
    rerender(<NetworkTab folder="/p" view={view({ link: { status: "not_running" } })} onSummarize={null} />);
    expect(screen.getAllByText(/Network Monitor isn't running/)).toHaveLength(2);
  });

  it("shows the newest request's outline and JSON until Claude summarizes it, and another when picked", async () => {
    render(<NetworkTab folder="/p" view={view({ items: [item("one"), item("two", { tx: tx("two", { status: 404 }) })] })} onSummarize={null} />);
    expect(await screen.findByRole("group", { name: "Response JSON" })).toBeInTheDocument();
    expect(screen.getByText("data[0].owner").nextSibling).toHaveTextContent("null");
    expect(screen.getByText("meta.total").nextSibling).toHaveTextContent("41");
    fireEvent.click(screen.getByRole("button", { name: /404 GET api\.x\/v1\/checklists\/two/ }));
    await waitFor(() => expect(api.networkResponse).toHaveBeenLastCalledWith("/p", "two"));
    expect(await screen.findByRole("group", { name: "Response JSON" })).toHaveTextContent('error: "not found"');
  });

  it("puts Claude's summary first, and Summarize asks Claude about that request", async () => {
    const onSummarize = vi.fn();
    const summarized = item("one", { summary: { id: "one", method: "GET", url: "u", status: 200, started_at: 0, text: "**41 checklists**, one with no owner", written_at: Date.now() } });
    render(<NetworkTab folder="/p" view={view({ items: [summarized] })} onSummarize={onSummarize} />);
    expect(screen.getByText("41 checklists")).toBeInTheDocument();
    expect(screen.queryByText("Outline")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Summarize again" }));
    expect(onSummarize).toHaveBeenCalledWith(summarized);
    await screen.findByRole("group", { name: "Response JSON" });
  });

  it("keeps a summary whose response Network Monitor has forgotten", async () => {
    vi.mocked(api.networkResponse).mockRejectedValue("Network Monitor no longer has that request");
    const gone = item("one", { watch: null, has_response: false, summary: { id: "one", method: "GET", url: "u", status: 200, started_at: 0, text: "Three items", written_at: Date.now() } });
    render(<NetworkTab folder="/p" view={view({ items: [gone] })} onSummarize={null} />);
    expect(screen.getByText("Three items")).toBeInTheDocument();
    expect(await screen.findByText(/The response itself is gone/)).toBeInTheDocument();
  });

  it("removes a watch from its chip, and offers to put it back for a few seconds", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<NetworkTab folder="/p" view={view()} onSummarize={null} />);
      fireEvent.click(screen.getByRole("button", { name: "Stop watching Checklists" }));
      expect(api.networkUnwatch).toHaveBeenCalledWith("/p", "Checklists");
      fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
      expect(api.networkRewatch).toHaveBeenCalledWith("/p", "Checklists", "GET", "/v1/checklists");
      expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
      // Left alone, the offer goes.
      fireEvent.click(screen.getByRole("button", { name: "Stop watching Checklists" }));
      await screen.findByRole("button", { name: "Undo" });
      act(() => void vi.advanceTimersByTime(5100));
      expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the detail on the request it showed when newer ones arrive, and brings them in with the N new pill", async () => {
    vi.mocked(api.networkResponse).mockClear();
    const { rerender } = render(<NetworkTab folder="/p" view={view({ items: [item("one")] })} onSummarize={null} />);
    await screen.findByRole("group", { name: "Response JSON" });
    expect(screen.queryByText(/new ↑/)).toBeNull();
    rerender(<NetworkTab folder="/p" view={view({ items: [item("two", { tx: tx("two", { status: 404 }) }), item("one")] })} onSummarize={null} />);
    // Still reading the first; the newer one is offered, not shown.
    expect(screen.getByRole("button", { name: /GET api\.x\/v1\/checklists\/one/ }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: "1 new ↑" })).toBeInTheDocument();
    expect(api.networkResponse).not.toHaveBeenCalledWith("/p", "two");
    fireEvent.click(screen.getByRole("button", { name: "1 new ↑" }));
    await waitFor(() => expect(api.networkResponse).toHaveBeenLastCalledWith("/p", "two"));
    expect(screen.queryByText(/new ↑/)).toBeNull();
    expect(screen.getByRole("button", { name: /404 GET api\.x\/v1\/checklists\/two/ }).getAttribute("aria-current")).toBe("true");
  });

  it("shows a link error under the status, not only in a tooltip", () => {
    render(<NetworkTab folder="/p" view={view({ link: { status: "error", message: "Network Monitor answered 500" } })} onSummarize={null} />);
    expect(screen.getByRole("status")).toHaveTextContent("Network Monitor answered 500");
  });

  it("shows Summarizing… until the summary arrives or Claude's turn ends, and Copied for a moment", async () => {
    const onSummarize = vi.fn();
    const items = [item("one")];
    const { rerender } = render(<NetworkTab folder="/p" view={view({ items })} onSummarize={onSummarize} busy={false} />);
    await screen.findByRole("group", { name: "Response JSON" });
    fireEvent.click(screen.getByRole("button", { name: "Summarize" }));
    expect((screen.getByRole("button", { name: "Summarizing…" }) as HTMLButtonElement).disabled).toBe(true);
    // The turn runs, then ends with no summary: the button is back.
    rerender(<NetworkTab folder="/p" view={view({ items })} onSummarize={onSummarize} busy />);
    expect(screen.getByRole("button", { name: "Summarizing…" })).toBeInTheDocument();
    rerender(<NetworkTab folder="/p" view={view({ items })} onSummarize={onSummarize} busy={false} />);
    expect(screen.getByRole("button", { name: "Summarize" })).toBeInTheDocument();
    // Or the summary arrives first.
    fireEvent.click(screen.getByRole("button", { name: "Summarize" }));
    const summarized = [item("one", { summary: { id: "one", method: "GET", url: "u", status: 200, started_at: 0, text: "Fine", written_at: Date.now() } })];
    rerender(<NetworkTab folder="/p" view={view({ items: summarized })} onSummarize={onSummarize} busy />);
    expect(screen.getByRole("button", { name: "Summarize again" })).toBeInTheDocument();

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
      fireEvent.click(await screen.findByRole("button", { name: "Copy JSON" }));
      await screen.findByRole("button", { name: "Copied" });
      act(() => void vi.advanceTimersByTime(1600));
      expect(screen.getByRole("button", { name: "Copy JSON" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
