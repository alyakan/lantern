import { act, fireEvent, screen, waitFor } from "@testing-library/react-native";
import { renderWith } from "../test/render";
import { TIP_IDS, TipJar, type Tip, type TipMemory, type TipPlatform } from "../tips";
import { SupportSheet, THANKS_MS } from "./SupportSheet";

const TIPS: Tip[] = [
  { id: TIP_IDS[0], name: "Small Coffee", price: "$0.99" },
  { id: TIP_IDS[1], name: "Large Coffee", price: "$2.99" },
  { id: TIP_IDS[2], name: "Generous Support", price: "$9.99" },
];

const memory = (at: number | null = null): TipMemory => ({ load: async () => at, save: async () => {} });

async function open(over: Partial<TipPlatform> = {}, last: number | null = null) {
  const platform: TipPlatform = { products: async () => TIPS, buy: jest.fn(async () => "thanked" as const), ...over };
  const jar = new TipJar(platform, memory(last));
  const onClose = jest.fn();
  await renderWith(<SupportSheet onClose={onClose} />, { tips: jar });
  return { jar, onClose, platform };
}

describe("Support development", () => {
  it("says it is optional and that everything stays free, and shows the three tips with their prices", async () => {
    await open();
    expect(screen.getByRole("header", { name: "Support development" })).toBeTruthy();
    expect(screen.getByText(/Everything stays free either way/)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: "Small Coffee, $0.99" })).toBeTruthy());
    expect(screen.getByRole("button", { name: "Large Coffee, $2.99" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Generous Support, $9.99" })).toBeTruthy();
  });

  it("shows the shape of the three tips while the store is asked, not a spinner", async () => {
    let release: (t: Tip[]) => void = () => {};
    await open({ products: () => new Promise((r) => (release = r)) });
    expect(screen.getByLabelText("Looking up the tips")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Coffee/ })).toBeNull();
    await act(async () => release(TIPS));
    await waitFor(() => expect(screen.getByRole("button", { name: "Large Coffee, $2.99" })).toBeTruthy());
    expect(screen.queryByLabelText("Looking up the tips")).toBeNull();
  });

  it("says the tips aren't available when the store can't be reached, and tries again when asked", async () => {
    let up = false;
    const { platform } = await open({ products: jest.fn(async () => (up ? TIPS : Promise.reject(new Error("offline")))) });
    await waitFor(() => expect(screen.getByText(/aren't available right now/)).toBeTruthy());
    up = true;
    await fireEvent.press(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Small Coffee, $0.99" })).toBeTruthy());
    expect(platform.products).toHaveBeenCalledTimes(2);
  });

  it("buys the tip that is pressed, and thanks for it", async () => {
    const { platform } = await open();
    await waitFor(() => screen.getByRole("button", { name: "Large Coffee, $2.99" }));
    await fireEvent.press(screen.getByRole("button", { name: "Large Coffee, $2.99" }));
    await waitFor(() => expect(screen.getByText("Thank you")).toBeTruthy());
    expect(platform.buy).toHaveBeenCalledWith(TIP_IDS[1]);
    expect(screen.queryByRole("button", { name: /Coffee/ })).toBeNull();
  });

  it("closes itself a moment after the thanks", async () => {
    const { onClose } = await open();
    await waitFor(() => screen.getByRole("button", { name: "Small Coffee, $0.99" }));
    jest.useFakeTimers();
    try {
      await fireEvent.press(screen.getByRole("button", { name: "Small Coffee, $0.99" }));
      await act(async () => void (await Promise.resolve()));
      await act(async () => void jest.advanceTimersByTime(THANKS_MS - 200));
      expect(onClose).not.toHaveBeenCalled();
      await act(async () => void jest.advanceTimersByTime(400));
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it("says nothing was charged when a purchase failed, keeps the tips, and can be tried again", async () => {
    let fail = true;
    await open({ buy: jest.fn(async () => (fail ? Promise.reject(new Error("store")) : ("thanked" as const))) });
    await waitFor(() => screen.getByRole("button", { name: "Small Coffee, $0.99" }));
    await fireEvent.press(screen.getByRole("button", { name: "Small Coffee, $0.99" }));
    await waitFor(() => expect(screen.getByText(/Nothing was charged/)).toBeTruthy());
    expect(screen.getByRole("button", { name: "Small Coffee, $0.99" })).toBeTruthy();
    fail = false;
    await fireEvent.press(screen.getByRole("button", { name: "Small Coffee, $0.99" }));
    await waitFor(() => expect(screen.getByText("Thank you")).toBeTruthy());
  });

  it("goes back to the list, quietly, when the person backs out of the purchase", async () => {
    await open({ buy: async () => "cancelled" });
    await waitFor(() => screen.getByRole("button", { name: "Small Coffee, $0.99" }));
    await fireEvent.press(screen.getByRole("button", { name: "Small Coffee, $0.99" }));
    await waitFor(() => expect(screen.queryByLabelText("Waiting for the store")).toBeNull());
    expect(screen.getByRole("button", { name: "Large Coffee, $2.99" })).toBeTruthy();
    expect(screen.queryByText("Thank you")).toBeNull();
    expect(screen.queryByText(/Nothing was charged/)).toBeNull();
  });

  it("says a tip awaits approval (Ask to Buy), without thanking yet", async () => {
    await open({ buy: async () => "pending" });
    await waitFor(() => screen.getByRole("button", { name: "Small Coffee, $0.99" }));
    await fireEvent.press(screen.getByRole("button", { name: "Small Coffee, $0.99" }));
    await waitFor(() => expect(screen.getByText(/waiting for approval/)).toBeTruthy());
    expect(screen.queryByText("Thank you")).toBeNull();
  });

  it("holds the other tips and the Close button while one is being bought, with dots to say so", async () => {
    let release: (o: "thanked") => void = () => {};
    const { platform, onClose } = await open({ buy: jest.fn(() => new Promise<"thanked">((r) => (release = r))) });
    await waitFor(() => screen.getByRole("button", { name: "Small Coffee, $0.99" }));
    await fireEvent.press(screen.getByRole("button", { name: "Small Coffee, $0.99" }));
    expect(screen.getByLabelText("Waiting for the store")).toBeTruthy();
    expect(screen.queryByText("Waiting for the store…")).toBeNull();
    await fireEvent.press(screen.getByRole("button", { name: "Large Coffee, $2.99" }));
    await fireEvent.press(screen.getByRole("button", { name: "Close" }));
    expect(platform.buy).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => release("thanked"));
    await waitFor(() => expect(screen.getByText("Thank you")).toBeTruthy());
  });

  it("thanks again, in other words, for someone who has tipped before", async () => {
    await open({}, Date.now() - 86_400_000 * 40);
    await waitFor(() => expect(screen.getByText(/You've supported Lantern before/)).toBeTruthy());
  });

  it("closes from Close", async () => {
    const { onClose } = await open();
    await waitFor(() => screen.getByRole("button", { name: "Small Coffee, $0.99" }));
    await fireEvent.press(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
