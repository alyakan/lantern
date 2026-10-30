import { fireEvent, render, screen } from "@testing-library/react-native";
import { StepPager, type PagePlaces } from "./StepPager";
import type { Row } from "../view/timeline";

// The page's scroll view, with what it is mockTold to do kept to be checked (the test renderer has no native one to move).
const mockTold = { scrollTo: jest.fn(), scrollToEnd: jest.fn() };
jest.mock("react-native-keyboard-controller", () => {
  const { forwardRef, useImperativeHandle } = jest.requireActual<typeof import("react")>("react");
  const { ScrollView } = jest.requireActual<typeof import("react-native")>("react-native");
  return {
    KeyboardChatScrollView: forwardRef((props: object, ref) => {
      useImperativeHandle(ref, () => ({ scrollTo: (o: object) => mockTold.scrollTo(o), scrollToEnd: (o: object) => mockTold.scrollToEnd(o) }));
      return <ScrollView {...props} />;
    }),
  };
});
beforeEach(() => {
  mockTold.scrollTo.mockClear();
  mockTold.scrollToEnd.mockClear();
});

const pages = [
  { key: "a", kicker: "Step 1 of 2", title: "One", rows: [] },
  { key: "b", kicker: "Step 2 of 2", title: "Two", rows: [] },
];

const heading = { kind: "page", key: "b" } as unknown as Row;
const said = { kind: "user", key: "q" } as unknown as Row;
const places = (offsets: Record<string, number> = {}): PagePlaces & { kept: Record<string, number> } => {
  const kept: Record<string, number> = {};
  return { kept, offset: (page) => offsets[page], keep: (page, y) => void (kept[page] = y) };
};
const laidOut = async (n: number, height = 2000) => {
  const page = screen.getByTestId(`step-page-${n}`);
  await fireEvent(page, "layout", { nativeEvent: { layout: { width: 390, height: 600 } } });
  await fireEvent(page, "contentSizeChange", 390, height);
  return page;
};

describe("the step pager", () => {
  it("goes from page to page with a swipe", async () => {
    await render(<StepPager pages={pages} index={1} onIndex={jest.fn()} renderRow={() => <></>} />);
    expect(screen.getByTestId("step-pager").props.scrollEnabled).toBe(true);
  });

  it("holds still while a swipe to allow is dragged, so the drag can't take it to the page before", async () => {
    await render(<StepPager pages={pages} index={1} onIndex={jest.fn()} renderRow={() => <></>} held />);
    expect(screen.getByTestId("step-pager").props.scrollEnabled).toBe(false);
  });

  it("opens a page scrolled to where it was left, and keeps where it is scrolled to", async () => {
    const p = places({ b: 840 });
    await render(<StepPager pages={pages} index={1} onIndex={jest.fn()} renderRow={() => <></>} places={p} />);
    const page = await laidOut(1);
    expect(mockTold.scrollTo).toHaveBeenCalledWith({ y: 840, animated: false });
    await fireEvent.scroll(page, { nativeEvent: { contentOffset: { x: 0, y: 1200 } } });
    expect(p.kept.b).toBe(1200);
  });

  it("goes no further down than the page reaches now", async () => {
    await render(<StepPager pages={pages} index={1} onIndex={jest.fn()} renderRow={() => <></>} places={places({ b: 5000 })} />);
    await laidOut(1);
    expect(mockTold.scrollTo).toHaveBeenCalledWith({ y: 1400, animated: false });
  });

  it("opens the newest page, never read, at its end when it was talked about, and at its top when not", async () => {
    const talked = [pages[0], { ...pages[1], rows: [heading, said] }];
    const { unmount } = await render(<StepPager pages={talked} index={1} onIndex={jest.fn()} renderRow={() => <></>} places={places()} />);
    await laidOut(1);
    expect(mockTold.scrollToEnd).toHaveBeenCalledWith({ animated: false });
    await unmount();
    mockTold.scrollToEnd.mockClear();
    await render(<StepPager pages={[pages[0], { ...pages[1], rows: [heading] }]} index={1} onIndex={jest.fn()} renderRow={() => <></>} places={places()} />);
    await laidOut(1);
    expect(mockTold.scrollToEnd).not.toHaveBeenCalled();
    expect(mockTold.scrollTo).not.toHaveBeenCalled();
  });
});
