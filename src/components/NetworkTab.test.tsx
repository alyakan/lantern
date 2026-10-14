import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NetworkTab } from "./NetworkTab";
import { api } from "../api";
import type { NetworkDetail, NetworkItem, NetworkTx, NetworkView } from "../types";

vi.mock("../api", () => ({ api: { networkResponse: vi.fn(), networkUnwatch: vi.fn() } }));

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
    expect(await screen.findByRole("tree", { name: "Response JSON" })).toBeInTheDocument();
    expect(screen.getByText("data[0].owner").nextSibling).toHaveTextContent("null");
    expect(screen.getByText("meta.total").nextSibling).toHaveTextContent("41");
    fireEvent.click(screen.getByRole("button", { name: /404 GET api\.x\/v1\/checklists\/two/ }));
    await waitFor(() => expect(api.networkResponse).toHaveBeenLastCalledWith("/p", "two"));
    expect(await screen.findByRole("tree")).toHaveTextContent('error: "not found"');
  });

  it("puts Claude's summary first, and Summarize asks Claude about that request", async () => {
    const onSummarize = vi.fn();
    const summarized = item("one", { summary: { id: "one", method: "GET", url: "u", status: 200, started_at: 0, text: "**41 checklists**, one with no owner", written_at: Date.now() } });
    render(<NetworkTab folder="/p" view={view({ items: [summarized] })} onSummarize={onSummarize} />);
    expect(screen.getByText("41 checklists")).toBeInTheDocument();
    expect(screen.queryByText("Outline")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Summarize again" }));
    expect(onSummarize).toHaveBeenCalledWith(summarized);
    await screen.findByRole("tree");
  });

  it("keeps a summary whose response Network Monitor has forgotten", async () => {
    vi.mocked(api.networkResponse).mockRejectedValue("Network Monitor no longer has that request");
    const gone = item("one", { watch: null, has_response: false, summary: { id: "one", method: "GET", url: "u", status: 200, started_at: 0, text: "Three items", written_at: Date.now() } });
    render(<NetworkTab folder="/p" view={view({ items: [gone] })} onSummarize={null} />);
    expect(screen.getByText("Three items")).toBeInTheDocument();
    expect(await screen.findByText(/The response itself is gone/)).toBeInTheDocument();
  });

  it("removes a watch from its chip", () => {
    render(<NetworkTab folder="/p" view={view()} onSummarize={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Stop watching Checklists" }));
    expect(api.networkUnwatch).toHaveBeenCalledWith("/p", "Checklists");
  });
});
