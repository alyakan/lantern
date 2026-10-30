import { render, screen } from "@testing-library/react-native";
import { StepPager } from "./StepPager";

const pages = [
  { key: "a", kicker: "Step 1 of 2", title: "One", rows: [] },
  { key: "b", kicker: "Step 2 of 2", title: "Two", rows: [] },
];

describe("the step pager", () => {
  it("goes from page to page with a swipe", async () => {
    await render(<StepPager pages={pages} index={1} onIndex={jest.fn()} renderRow={() => <></>} />);
    expect(screen.getByTestId("step-pager").props.scrollEnabled).toBe(true);
  });

  it("holds still while a swipe to allow is dragged, so the drag can't take it to the page before", async () => {
    await render(<StepPager pages={pages} index={1} onIndex={jest.fn()} renderRow={() => <></>} held />);
    expect(screen.getByTestId("step-pager").props.scrollEnabled).toBe(false);
  });
});
