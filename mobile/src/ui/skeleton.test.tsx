import { StyleSheet, View } from "react-native";
import { render, screen } from "@testing-library/react-native";
import { Bar, ChatSkeleton, DiffSkeleton, Dots, HomeSkeleton, ProjectsSkeleton, Pulse, PULSE_MIN, SHAPE, SHAPE_DARK } from "./skeleton";
import { colors } from "./theme";

/** WCAG's contrast ratio between two #rrggbb colours (1: the same, 21: black on white). */
function contrast(a: string, b: string) {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** A colour laid over a background at some opacity (what breathing does to a shape against the page). */
function over(fg: string, bg: string, alpha: number) {
  const mix = (i: number) => Math.round(parseInt(fg.slice(i, i + 2), 16) * alpha + parseInt(bg.slice(i, i + 2), 16) * (1 - alpha));
  return `#${[1, 3, 5].map((i) => mix(i).toString(16).padStart(2, "0")).join("")}`;
}

describe("the loading shapes can be seen", () => {
  it("against the page and a white card, even at the faintest of their breathing", () => {
    for (const [name, shape] of [["light", SHAPE], ["dark", SHAPE_DARK]] as const) {
      for (const [where, ground] of [["page", colors.paper], ["card", colors.card]] as const) {
        expect(contrast(over(shape, ground, PULSE_MIN), ground)).toBeGreaterThanOrEqual(name === "light" ? 1.12 : 1.3);
        void where;
      }
    }
  });

  it("which the page's own rule colour, used before, did not manage", () => {
    // Under the 1.12 the lightest shape is held to above.
    expect(contrast(over(colors.rule, colors.paper, 0.45), colors.paper)).toBeLessThan(1.12);
  });
});

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
