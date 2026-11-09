import "@shopify/flash-list/jestSetup";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { act, fireEvent, screen } from "@testing-library/react-native";
import { attachSession } from "../test/fakeSession";
import { chat, makeController, renderWith } from "../test/render";
import { ChatScreen } from "./ChatScreen";

function Chats() {
  const [slot, setSlot] = useState("a");
  return (
    <View style={{ flex: 1 }}>
      {["a", "b", "c"].map((id) => (
        <Pressable key={id} accessibilityRole="button" accessibilityLabel={`Open chat ${id}`} onPress={() => setSlot(id)}>
          <Text>{id}</Text>
        </Pressable>
      ))}
      <ChatScreen slot={slot} onBack={() => {}} onReview={() => {}} />
    </View>
  );
}

it("shows only the current chat's checklist, including when another chat's plan updates", async () => {
  const { controller } = makeController();
  attachSession(controller);
  await renderWith(<Chats />, {
    chats: [chat({ slot: "a" }), chat({ slot: "b" }), chat({ slot: "c" })],
    events: {
      a: [{ kind: "todos", items: [{ content: "Fix the input border", status: "in_progress", active_form: "Fixing the input border" }] }],
      b: [{ kind: "todos", items: [{ content: "Review the release", status: "pending", active_form: "Reviewing the release" }] }],
    },
  }, controller);

  await fireEvent.press(screen.getByRole("button", { name: /Plan,.*Fixing the input border/ }));
  expect(screen.getByLabelText("Doing: Fix the input border")).toBeTruthy();

  await fireEvent.press(screen.getByRole("button", { name: "Open chat b" }));
  const otherPlan = screen.getByRole("button", { name: /Plan,.*Review the release/ });
  expect(otherPlan.props.accessibilityState.expanded).toBe(false);
  expect(screen.queryByLabelText("Doing: Fix the input border")).toBeNull();
  await fireEvent.press(otherPlan);
  expect(screen.getByLabelText("To do: Review the release")).toBeTruthy();

  await act(async () => controller.sync.apply({ type: "pushed", msg: { type: "event", slot: "a", seq: 2, event: { kind: "todos", items: [{ content: "Ship the border fix", status: "pending", active_form: "Shipping the border fix" }] } } }));
  expect(screen.getByLabelText("To do: Review the release")).toBeTruthy();
  expect(screen.queryByText("Ship the border fix")).toBeNull();

  await fireEvent.press(screen.getByRole("button", { name: "Open chat c" }));
  expect(screen.queryByRole("button", { name: /^Plan,/ })).toBeNull();
  await fireEvent.press(screen.getByRole("button", { name: "Open chat a" }));
  expect(screen.getByRole("button", { name: /Plan,.*Ship the border fix/ })).toBeTruthy();
  expect(screen.queryByText("Review the release")).toBeNull();
});
