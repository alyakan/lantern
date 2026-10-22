import { fireEvent, screen } from "@testing-library/react-native";
import { renderWith } from "../test/render";
import { PlanCard, SlashPicker, UsageRow } from "./ChatExtras";

const todo = (content: string, status: string, active_form = `${content}…`) => ({ content, status, active_form });

describe("the plan Claude is keeping", () => {
  it("is one line with how far it is and what is being done, and opens to every step", async () => {
    await renderWith(<PlanCard todos={[todo("Write tests", "completed"), todo("Fix the bug", "in_progress", "Fixing the bug"), todo("Ship it", "pending")]} />);
    const line = screen.getByRole("button", { name: "Plan, 1 of 3 done, now: Fixing the bug" });
    expect(screen.queryByLabelText("To do: Ship it")).toBeNull();
    fireEvent.press(line);
    expect(await screen.findByLabelText("Done: Write tests")).toBeTruthy();
    expect(screen.getByLabelText("Doing: Fix the bug")).toBeTruthy();
    expect(screen.getByLabelText("To do: Ship it")).toBeTruthy();
  });

  it("is not there with no plan, or once every step is done", async () => {
    const { toJSON } = await renderWith(<PlanCard todos={[]} />);
    expect(toJSON()).toBeNull();
    await renderWith(<PlanCard todos={[todo("A", "completed")]} />);
    expect(screen.queryByLabelText(/^Plan,/)).toBeNull();
  });
});

describe("the commands offered after a slash", () => {
  const commands = [
    { name: "review", description: "Review a pull request", argument_hint: "[pr]" },
    { name: "compact", description: "", argument_hint: "" },
  ];

  it("lists each with what it does, and a tap picks one", async () => {
    const onPick = jest.fn();
    await renderWith(<SlashPicker matches={commands} onPick={onPick} />);
    expect(screen.getByText("Review a pull request")).toBeTruthy();
    fireEvent.press(screen.getByRole("button", { name: "/review, Review a pull request" }));
    expect(onPick).toHaveBeenCalledWith(commands[0]);
    expect(screen.getByRole("button", { name: "/compact" })).toBeTruthy();
  });

  it("is nothing when nothing matches", async () => {
    const { toJSON } = await renderWith(<SlashPicker matches={[]} onPick={jest.fn()} />);
    expect(toJSON()).toBeNull();
  });
});

describe("the plan usage", () => {
  it("says how much of the window is used and when it resets", async () => {
    await renderWith(<UsageRow plan={{ used: 0.42, resetsAt: Date.now() / 1000 + 130 * 60 + 30, status: "allowed" }} />);
    expect(screen.getByText("42% used")).toBeTruthy();
    expect(screen.getByLabelText(/Plan usage: 42 percent of the five-hour window used\. Resets in 2 h/)).toBeTruthy();
  });

  it("says the limit is reached", async () => {
    await renderWith(<UsageRow plan={{ used: 1, resetsAt: null, status: "rejected" }} />);
    expect(screen.getByText("Limit reached")).toBeTruthy();
  });
});
