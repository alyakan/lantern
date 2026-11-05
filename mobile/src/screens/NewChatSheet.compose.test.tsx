import { fireEvent, screen, waitFor } from "@testing-library/react-native";
import type { Picked } from "../platformImages";
import { pickImages } from "../platformImages";
import { loadLastProject, saveLastProject } from "../prefs";
import { attachSession } from "../test/fakeSession";
import { connectedWith, makeController, renderWith } from "../test/render";
import { NewChatSheet } from "./NewChatSheet";

jest.mock("../platformImages", () => ({ pickImages: jest.fn() }));
jest.mock("../prefs", () => ({ ...jest.requireActual("../prefs"), loadNewChatPermissions: jest.fn(async () => "ask"), saveNewChatPermissions: jest.fn(async () => {}), loadLastProject: jest.fn(async () => null), saveLastProject: jest.fn(async () => {}) }));
const pick = pickImages as jest.Mock<Promise<Picked>, [string, number]>;
const lastProject = loadLastProject as jest.Mock;
const keepProject = saveLastProject as jest.Mock;

const projects = [
  { id: "/Users/me/lantern", name: "lantern" },
  { id: "/Users/me/rayak", name: "rayak" },
  { id: "/Users/me/website", name: "website" },
];

async function open(features: string[] = [], props: Partial<Parameters<typeof NewChatSheet>[0]> = {}) {
  const { controller } = makeController();
  const session = attachSession(controller, { projects, new_chat: { slot: "s9" } }, features);
  const onStarted = jest.fn();
  await renderWith(<NewChatSheet onClose={jest.fn()} onStarted={onStarted} {...props} />, { connection: connectedWith(features) }, controller);
  await waitFor(() => expect(screen.getByRole("button", { name: /^Project: / })).toBeTruthy());
  return { onStarted, ...session };
}
const write = (text: string) => fireEvent.changeText(screen.getByLabelText("What to start with"), text);

beforeEach(() => {
  pick.mockReset();
  lastProject.mockReset().mockImplementation(async () => null);
  keepProject.mockReset();
});

describe("composing a new chat", () => {
  it("goes where the words point, says it guessed, and starts there", async () => {
    const { lastOf } = await open();
    await write("the games timer in rayak resets when you rotate");
    await waitFor(() => expect(screen.getByRole("button", { name: "Project: rayak, guessed from what you said" })).toBeTruthy());
    await fireEvent.press(screen.getByRole("button", { name: "Start the chat" }));
    await waitFor(() => expect(lastOf("new_chat")).toMatchObject({ project: "/Users/me/rayak" }));
    expect(keepProject).toHaveBeenCalledWith("/Users/me/rayak");
  });

  it("starts where this phone last started one when the words name no project", async () => {
    lastProject.mockImplementation(async () => "/Users/me/website");
    await open();
    await write("make it faster");
    await waitFor(() => expect(screen.getByRole("button", { name: "Project: website" })).toBeTruthy());
  });

  it("stops guessing once a project is picked by hand", async () => {
    await open();
    await fireEvent.press(screen.getByRole("button", { name: /^Project: / }));
    await fireEvent.press(screen.getByRole("radio", { name: "website" }));
    await write("something in rayak");
    expect(screen.getByRole("button", { name: "Project: website" })).toBeTruthy();
  });

  it("sends photos with the first message to a Mac that takes them", async () => {
    pick.mockResolvedValue({ images: [{ id: "img-1", uri: "file:///1.jpg", data: "/9j/DATA", mediaType: "image/jpeg", width: 10, height: 10 }] });
    const { lastOf } = await open(["newchatimages"]);
    await fireEvent.press(screen.getByRole("button", { name: "Add photos" }));
    await waitFor(() => expect(screen.getByLabelText("Photo 1")).toBeTruthy());
    expect(pick).toHaveBeenCalledWith("library", expect.any(Number));
    await write("what's wrong on this screen?");
    await fireEvent.press(screen.getByRole("button", { name: "Start the chat" }));
    await waitFor(() => expect(lastOf("new_chat")).toMatchObject({ text: "what's wrong on this screen?", images: [{ media_type: "image/jpeg", data: "/9j/DATA" }] }));
  });

  it("offers no photos to a Mac that can't take them with a new chat, and sends none", async () => {
    const { lastOf } = await open();
    expect(screen.queryByRole("button", { name: "Add photos" })).toBeNull();
    await write("fix it");
    await fireEvent.press(screen.getByRole("button", { name: "Start the chat" }));
    await waitFor(() => expect(lastOf("new_chat")).toBeTruthy());
    expect("images" in (lastOf("new_chat") as Record<string, unknown>)).toBe(false);
  });
});
