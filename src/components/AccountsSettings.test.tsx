import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { AccountsSettings } from "./AccountsSettings";
import { AccountPicker } from "./AccountPicker";

let calls: [string, Record<string, unknown>][] = [];
let listed: { id: string; name: string }[] = [];
let signedIn: Record<string, string | null> = {};

const backend = () =>
  mockIPC((cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    calls.push([cmd, a]);
    if (cmd === "list_accounts") return listed;
    if (cmd === "claude_login") return { logged_in: !!signedIn[String(a.account)], account: signedIn[String(a.account)] ?? null };
    if (cmd === "add_account") return { id: String(a.name).toLowerCase(), name: a.name };
    if (cmd === "account_login") return { logged_in: true, account: "me@work.dev" };
    if (cmd === "remove_account") return null;
    return null;
  });
const sent = (cmd: string) => calls.filter(([c]) => c === cmd).map(([, a]) => a);

beforeEach(() => {
  clearMocks();
  calls = [];
  listed = [{ id: "work", name: "Work" }];
  signedIn = { work: "me@work.dev" };
});
afterEach(cleanup);

describe("Settings → Accounts", () => {
  it("lists each account with who it is signed in as, asked of its own folder", async () => {
    backend();
    render(<AccountsSettings claudePath="/bin/claude" onChanged={() => {}} />);
    expect(await screen.findByText("Signed in as me@work.dev")).toBeInTheDocument();
    expect(sent("claude_login")).toEqual([{ claudePath: "/bin/claude", account: "work" }]);
  });

  it("adds an account and starts its sign-in at once", async () => {
    backend();
    const onChanged = vi.fn();
    render(<AccountsSettings claudePath="/bin/claude" onChanged={onChanged} />);
    await screen.findByText("Work");
    fireEvent.change(screen.getByLabelText("Account name"), { target: { value: "Home" } });
    fireEvent.click(screen.getByRole("button", { name: "Add and sign in" }));
    await waitFor(() => expect(sent("account_login")).toEqual([{ claudePath: "/bin/claude", id: "home" }]));
    expect(sent("add_account")).toEqual([{ name: "Home" }]);
    expect(onChanged).toHaveBeenCalledWith([{ id: "work", name: "Work" }, { id: "home", name: "Home" }]);
  });

  it("removes an account and says which one went, so a project that started on it is reset", async () => {
    backend();
    const onChanged = vi.fn();
    render(<AccountsSettings claudePath="/bin/claude" onChanged={onChanged} />);
    await screen.findByText("Work");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith([], "work"));
    expect(sent("remove_account")).toEqual([{ claudePath: "/bin/claude", id: "work" }]);
  });

  it("can't sign anything in while Claude Code isn't found", async () => {
    backend();
    render(<AccountsSettings claudePath={null} onChanged={() => {}} />);
    expect(await screen.findByText(/Claude Code wasn't found/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Sign in/ })).toBeDisabled();
    expect(sent("claude_login")).toEqual([]);
  });
});

describe("The account picker", () => {
  it("offers the default login and each account, and says which one is chosen", () => {
    const onChoose = vi.fn();
    render(<AccountPicker accounts={[{ id: "work", name: "Work" }]} chosen="" onChoose={onChoose} />);
    fireEvent.click(screen.getByRole("button", { name: /Default login/ }));
    expect(screen.getByRole("menuitemradio", { name: "Default login" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Work" }));
    expect(onChoose).toHaveBeenCalledWith("work");
  });
});
