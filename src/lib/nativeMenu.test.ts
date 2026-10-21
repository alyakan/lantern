import { afterEach, describe, expect, it } from "vitest";
import { fireEvent } from "@testing-library/react";
import { holdBackBrowserMenu } from "./nativeMenu";

describe("holdBackBrowserMenu", () => {
  let undo = () => {};
  afterEach(() => {
    undo();
    document.body.innerHTML = "";
    window.getSelection()?.removeAllRanges();
  });
  const setUp = (html: string) => {
    document.body.innerHTML = html;
    undo = holdBackBrowserMenu();
  };

  it("holds back the browser's menu on the page", () => {
    setUp(`<div id="page">chat</div>`);
    // fireEvent returns false when the default was prevented.
    expect(fireEvent.contextMenu(document.getElementById("page")!)).toBe(false);
  });

  it("leaves the menu in a text field, where Copy and Paste are wanted", () => {
    setUp(`<textarea id="box"></textarea><input id="line" /><div id="edit" contenteditable="true"></div>`);
    for (const id of ["box", "line", "edit"]) expect(fireEvent.contextMenu(document.getElementById(id)!)).toBe(true);
  });

  it("leaves the menu over selected text, so it can be copied", () => {
    setUp(`<p id="text">some text</p>`);
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("text")!);
    window.getSelection()!.addRange(range);
    expect(fireEvent.contextMenu(document.getElementById("text")!)).toBe(true);
  });

  it("stops holding it back after undo", () => {
    setUp(`<div id="page">chat</div>`);
    const page = document.getElementById("page")!;
    undo();
    expect(fireEvent.contextMenu(page)).toBe(true);
  });
});
