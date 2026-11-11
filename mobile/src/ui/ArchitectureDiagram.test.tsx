import { fireEvent, render, screen } from "@testing-library/react-native";
import { StyleSheet } from "react-native";
import { Markdown } from "./Markdown";
import { lightColors } from "./theme";

jest.mock("react-native-webview", () => {
  const React = require("react");
  const { View } = require("react-native");
  return { WebView: (props: Record<string, unknown>) => React.createElement(View, { testID: "map-web", ...props }) };
});
jest.mock("react-native-svg", () => {
  const React = require("react");
  const { View } = require("react-native");
  return { SvgXml: (props: Record<string, unknown>) => React.createElement(View, { testID: "map-svg", ...props }) };
});
let mockWindow = { width: 393, height: 852 };
jest.mock("react-native/Libraries/Utilities/useWindowDimensions", () => ({ __esModule: true, default: () => ({ ...mockWindow, scale: 3, fontScale: 1 }) }));
beforeEach(() => { mockWindow = { width: 393, height: 852 }; });

const text = '```architecture\n{"nodes":[{"id":"phone","label":"Phone"},{"id":"mac","label":"Mac"}],"edges":[{"from":"phone","to":"mac","label":"connects"}]}\n```';
const full = () => screen.getAllByTestId("map-web").find(w => w.props.javaScriptEnabled)!;
const open = async () => fireEvent.press(screen.getByRole("button", { name: "Open architecture map, 2 nodes and 1 connections" }));

it("renders a chat preview and opens an isolated full-screen map with both landscape orientations", async () => {
  await render(<Markdown text={text} />);
  const preview = screen.getByTestId("map-svg", { includeHiddenElements: true });
  expect(preview.props.xml).toContain('data-node="phone"');
  expect(screen.queryByTestId("map-web", { includeHiddenElements: true })).toBeNull();
  await open();
  expect(full().props.source.html).toContain('id="clear"');
  expect(full().props.domStorageEnabled).toBe(false);
  expect(full().props.onShouldStartLoadWithRequest({ url: "about:blank" })).toBe(true);
  expect(full().props.onShouldStartLoadWithRequest({ url: "https://example.com" })).toBe(false);
  const modal = screen.getByTestId("architecture-viewer");
  expect(modal.props.presentationStyle).toBe("fullScreen");
  expect(modal.props.supportedOrientations).toEqual(["portrait", "portrait-upside-down", "landscape-left", "landscape-right"]);
  expect(StyleSheet.flatten(screen.getByText("Close").props.style).color).toBe(lightColors.ink);
  await fireEvent.press(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByTestId("map-web", { includeHiddenElements: true })).toBeNull();
});

it("keeps the document mounted on rotation and seeds the last selection when reopened", async () => {
  const { rerender } = await render(<Markdown text={text} />);
  await open();
  const source = full().props.source;
  await fireEvent(full(), "message", { nativeEvent: { data: '{"selection":{"kind":"node","id":"phone"}}' } });
  mockWindow = { width: 852, height: 393 };
  // A changed prop redraws the memoised message; the map document itself remains the same.
  await rerender(<Markdown text={text} selectable={false} />);
  expect(full().props.source).toBe(source);
  await fireEvent.press(screen.getByRole("button", { name: "Close" }));
  await open();
  expect(full().props.source.html).toContain('type="application/json">{"kind":"node","id":"phone"}');
  await fireEvent(full(), "message", { nativeEvent: { data: '{"selection":{"kind":"node","id":"missing"}}' } });
  await fireEvent.press(screen.getByRole("button", { name: "Close" }));
  await open();
  expect(full().props.source.html).toContain('type="application/json">{"kind":"node","id":"phone"}');
  await fireEvent(full(), "message", { nativeEvent: { data: '{"selection":null}' } });
  await fireEvent.press(screen.getByRole("button", { name: "Close" }));
  await open();
  expect(full().props.source.html).toContain('type="application/json">null');
});

it("leaves incomplete diagram JSON readable as source and falls back if the web view fails", async () => {
  const { rerender } = await render(<Markdown text={'```architecture\n{"nodes":['} />);
  expect(screen.queryByTestId("map-web")).toBeNull();
  expect(screen.getByText('{"nodes":[')).toBeTruthy();
  await rerender(<Markdown text={text} />);
  await open();
  await fireEvent(full(), "error");
  expect(screen.queryByTestId("map-web")).toBeNull();
  expect(screen.getByText("architecture")).toBeTruthy();
});

it("recovers a terminated content process without losing the pinned selection", async () => {
  await render(<Markdown text={text} />);
  await open();
  await fireEvent(full(), "message", { nativeEvent: { data: '{"selection":{"kind":"edge","id":"e0"}}' } });
  const first = full().props.source;
  await fireEvent(full(), "contentProcessDidTerminate");
  expect(full().props.source).not.toBe(first);
  expect(full().props.source.html).toContain('type="application/json">{"kind":"edge","id":"e0"}');
  await fireEvent(full(), "renderProcessGone");
  expect(full().props.source.html).toContain('type="application/json">{"kind":"edge","id":"e0"}');
});
