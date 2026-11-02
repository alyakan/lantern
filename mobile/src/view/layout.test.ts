import { CHANGES_MIN, CHANGES_SHARE, CHANGES_WIDTH, CHAT_MIN, changesWidth, floatFrame, hasRoomForChanges, layoutFor, shareOf } from "./layout";

describe("layoutFor", () => {
  it("keeps the phone's layout on a phone, and in a narrow Split View or Slide Over pane", () => {
    expect(layoutFor(393, 852)).toBe("phone");
    expect(layoutFor(440, 956)).toBe("phone");
    expect(layoutFor(320, 1024)).toBe("phone");
    expect(layoutFor(678, 834)).toBe("phone");
    expect(layoutFor(699, 400)).toBe("phone");
  });

  it("slides the chats in over the chat on a tablet held upright", () => {
    expect(layoutFor(744, 1133)).toBe("overlay");
    expect(layoutFor(834, 1194)).toBe("overlay");
    expect(layoutFor(1032, 1376)).toBe("overlay");
  });

  it("puts the chats beside the chat on a tablet held sideways", () => {
    expect(layoutFor(1133, 744)).toBe("split");
    expect(layoutFor(1194, 834)).toBe("split");
    expect(layoutFor(1376, 1032)).toBe("split");
  });

  it("follows the window, not the device: a pane that is wide enough but taller than wide, or too narrow to share, slides the chats in", () => {
    expect(layoutFor(750, 1000)).toBe("overlay");
    expect(layoutFor(700, 700)).toBe("overlay");
    expect(layoutFor(800, 500)).toBe("overlay");
    expect(layoutFor(900, 600)).toBe("split");
  });
});

describe("the Changes pane's room", () => {
  it("is beside the chat once the chats are away, in a window wide enough for both", () => {
    expect(hasRoomForChanges("overlay", CHANGES_MIN)).toBe(true);
    expect(hasRoomForChanges("overlay", CHANGES_MIN - 1)).toBe(false);
  });

  it("is a sheet while the chats are beside the chat, however wide the window", () => {
    expect(hasRoomForChanges("split", 1400)).toBe(false);
    expect(hasRoomForChanges("phone", 1400)).toBe(false);
  });
});

describe("the Changes pane's width beside the chat", () => {
  it("is half the window until dragged", () => {
    expect(changesWidth(CHANGES_SHARE, 1366)).toBe(683);
    expect(changesWidth(CHANGES_SHARE, 1194)).toBe(597);
  });

  it("keeps the chat readable and itself readable, however far it is dragged", () => {
    expect(changesWidth(0.9, 1366)).toBe(1366 - CHAT_MIN);
    expect(changesWidth(0.05, 1366)).toBe(CHANGES_WIDTH);
    // In the narrowest window that has room for both, the chat keeps its 500.
    expect(changesWidth(CHANGES_SHARE, CHANGES_MIN)).toBe(CHANGES_MIN - CHAT_MIN);
  });

  it("is kept as a share, so a turned tablet keeps the same split", () => {
    const share = shareOf(400, 1000);
    expect(share).toBe(0.4);
    expect(changesWidth(share, 1366)).toBe(546);
    expect(shareOf(2000, 1000)).toBe((1000 - CHAT_MIN) / 1000);
  });
});

describe("the floating Changes", () => {
  it("are a big card in the middle of the window, between the bars", () => {
    expect(floatFrame(1366, 1024, 24, 20)).toEqual({ x: 137, y: 93, w: 1093, h: 843 });
  });

  it("don't spread across a very wide window", () => {
    expect(floatFrame(2000, 1000).w).toBe(1100);
  });
});
