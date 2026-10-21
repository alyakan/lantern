import { StyleSheet, View } from "react-native";
import { render, screen } from "@testing-library/react-native";
import { Bar, ChatSkeleton, DiffSkeleton, Dots, HomeSkeleton, ProjectsSkeleton, Pulse } from "./skeleton";

describe("the loading shapes", () => {
  it("tell a screen reader what is loading, once, and keep their grey blocks out of its way", async () => {
    await render(
      <Pulse label="Loading the thing">
        <Bar w="50%" />
      </Pulse>,
    );
    const group = screen.getByLabelText("Loading the thing");
    expect(group.props.accessibilityRole).toBe("progressbar");
    expect(group.props.accessible).toBe(true);
    // The blocks inside are hidden from it.
    expect(group.children[0]).toBeTruthy();
    expect(typeof group.children[0] === "string" ? undefined : group.children[0].props.accessibilityElementsHidden).toBe(true);
  });

  it("are not announced at all without a label", async () => {
    await render(
      <Pulse>
        <Bar />
      </Pulse>,
    );
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("draw a block of the size asked for, pill-round by default and darker when asked", async () => {
    await render(
      <View testID="blocks">
        <Bar w={80} h={20} />
        <Bar w="40%" h={30} r={6} dark />
      </View>,
    );
    const [light, dark] = screen.getByTestId("blocks").children.flatMap((c) => (typeof c === "string" ? [] : [c]));
    expect(StyleSheet.flatten(light.props.style)).toMatchObject({ width: 80, height: 20, borderRadius: 10 });
    expect(StyleSheet.flatten(dark.props.style)).toMatchObject({ width: "40%", height: 30, borderRadius: 6 });
  });

  it("have a shape for a chat, the project picker, a diff and Home, each named for what is loading", async () => {
    await render(
      <View>
        <ChatSkeleton />
        <ChatSkeleton label="Loading earlier messages" />
        <ProjectsSkeleton />
        <DiffSkeleton />
        <HomeSkeleton />
      </View>,
    );
    for (const name of ["Loading this chat", "Loading earlier messages", "Looking at your projects", "Loading the changes", "Loading your chats"]) {
      expect(screen.getByLabelText(name)).toBeTruthy();
    }
  });

  it("have three dots for work with no shape to draw, hidden from a screen reader (the words beside them say it)", async () => {
    await render(
      <View testID="dots-parent">
        <Dots />
      </View>,
    );
    const row = screen.getByTestId("dots-parent").children[0];
    expect(typeof row === "string" ? 0 : row.children).toHaveLength(3);
    expect(typeof row === "string" ? undefined : row.props.accessibilityElementsHidden).toBe(true);
  });
});
