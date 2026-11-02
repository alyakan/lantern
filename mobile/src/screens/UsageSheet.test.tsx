import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { resetUsageHistory, recordUsage } from "../usageHistory";
import { UsageSheet } from "./UsageSheet";

const mockStore = new Map<string, string>();
jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 1,
  getItemAsync: jest.fn(async (k: string) => mockStore.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => void mockStore.set(k, v)),
  deleteItemAsync: jest.fn(async (k: string) => void mockStore.delete(k)),
}));

beforeEach(() => {
  mockStore.clear();
  resetUsageHistory();
});

describe("the usage sheet", () => {
  it("says where the windows stand and draws a bar for each of seven days", async () => {
    await render(<UsageSheet plan={{ used: 0.42, resetsAt: null, status: "allowed", week: { used: 0.3, resetsAt: null } }} onClose={jest.fn()} />);
    expect(screen.getByText(/Session: 42% used/)).toBeTruthy();
    expect(screen.getByText(/Week: 30% used/)).toBeTruthy();
    expect(screen.getByTestId("usage-chart").props.accessibilityLabel).toMatch(/nothing seen/);
    expect(screen.getAllByText(/has not seen enough yet/)[0]).toBeTruthy();
  });

  it("shows what the phone has seen today", async () => {
    await act(async () => {
      recordUsage({ used: 0.65, resetsAt: null, status: "allowed" });
      await new Promise((r) => setTimeout(r, 10));
    });
    await render(<UsageSheet plan={{ used: 0.65, resetsAt: null, status: "allowed" }} onClose={jest.fn()} />);
    expect(screen.getAllByText("65%").length).toBeGreaterThan(0);
    expect(screen.getByText(/has seen 1 day of numbers/)).toBeTruthy();
  });

  it("closes", async () => {
    const onClose = jest.fn();
    await render(<UsageSheet plan={{ used: 0.1, resetsAt: null, status: "allowed" }} onClose={onClose} />);
    await fireEvent.press(screen.getByRole("button", { name: "Close" }));
    await new Promise((r) => setTimeout(r, 400));
    expect(onClose).toHaveBeenCalled();
  });
});

it("keeps Claude exhaustion separate from Codex usage", async () => {
  await render(<UsageSheet plan={{ used: 1, resetsAt: null, status: "rejected" }} providers={{ codex: { provider: "codex", updated_at: 1, windows: [{ label: "5 hours", minutes: 300, used: .2, resets_at: null }] } }} onClose={jest.fn()} />);
  expect(screen.getByText(/Session: 100% used · limit reached/)).toBeTruthy();
  expect(screen.getByText(/5 hours: 20% used/)).toBeTruthy();
});

it("keeps each provider's history separate", async () => {
  await act(async () => {
    recordUsage({ used: .9, resetsAt: null, status: "allowed" });
    recordUsage({ used: .2, resetsAt: null, status: "allowed" }, Date.now(), "codex");
    await new Promise(r => setTimeout(r, 10));
  });
  await render(<UsageSheet plan={null} onClose={jest.fn()} />);
  expect(screen.getByTestId("usage-chart").props.accessibilityLabel).toContain("90 percent");
  expect(screen.getByTestId("usage-chart-codex").props.accessibilityLabel).toContain("20 percent");
  expect(screen.getByTestId("usage-chart-codex").props.accessibilityLabel).not.toContain("90 percent");
});
