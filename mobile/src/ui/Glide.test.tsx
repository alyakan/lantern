import { fireEvent, render, screen } from "@testing-library/react-native";
import { Text } from "react-native";
import { Glide } from "./Glide";

const layoutAt = (y: number) => ({ nativeEvent: { layout: { x: 0, y, width: 100, height: 50 } } });

describe("a row that glides to its new place", () => {
  it("holds what it is given, and rests in place once it has been moved (motion is skipped on Node)", async () => {
    await render(
      <Glide testID="glide">
        <Text>Release</Text>
      </Glide>,
    );
    await fireEvent(screen.getByTestId("glide"), "layout", layoutAt(100));
    // Laid out somewhere else: it would start from where it was, and ends at rest.
    await fireEvent(screen.getByTestId("glide"), "layout", layoutAt(160));
    expect(screen.getByText("Release")).toBeTruthy();
    expect(screen.getByTestId("glide")).toHaveStyle({ transform: [{ translateY: 0 }] });
  });
});
