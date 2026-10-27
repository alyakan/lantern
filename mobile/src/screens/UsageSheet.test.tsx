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
    expect(screen.getByText(/42% of the five-hour window is used/)).toBeTruthy();
    expect(screen.getByText(/30% of the weekly limit used/)).toBeTruthy();
    expect(screen.getByTestId("usage-chart").props.accessibilityLabel).toMatch(/nothing seen/);
    expect(screen.getByText(/has not seen enough yet/)).toBeTruthy();
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
