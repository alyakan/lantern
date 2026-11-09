import { fireEvent, render, screen } from "@testing-library/react-native";
import type { ReviewFile } from "../view/review";
import { ReviewFilePage } from "./ReviewPage";

const page = (over: Partial<ReviewFile> = {}): ReviewFile => ({
  path: null,
  added: 0,
  removed: 391,
  preface: "Files: `Lumiform/Extensions/UIImage+Resized.swift`, `LumiformTests/Extensions/UIImageResizedTests.swift`",
  changed: "This removes the retry resize.\n- `resizeWithCoreGraphics` removed:\n  - `Lumiform/Extensions/UIImage+Resized.swift:52`\n- `.github/workflows/tests.yml:154`: the new job.",
  findings: [{ index: 0, line: 10, lineEnd: null, severity: "nit", text: "Two failures share a name, see `Packages/PhotoImportKit/Tests/PhotoEncoderTests.swift:12`.", path: "Packages/PhotoImportKit/Tests/PhotoEncoderTests.swift" }],
  clean: false,
  notes: "- **Drawings keep transparency:** they still go through `resizeWithUIKit`.\n  - `Lumiform/Inspection/FormItem/Question/Signature/Inpection+DrawingData.swift:32`",
  ...over,
});

describe("a Review page's paths", () => {
  it("opens the change in a path named in What changed, a finding, the notes or the lines above them, at its file", async () => {
    const onOpen = jest.fn();
    await render(<ReviewFilePage kicker="File 7 of 20" file={page()} verdicts={undefined} onOpen={onOpen} />);
    await fireEvent.press(screen.getByText("Lumiform/Extensions/UIImage+Resized.swift:52"));
    await fireEvent.press(screen.getByText(".github/workflows/tests.yml:154"));
    await fireEvent.press(screen.getByText("Packages/PhotoImportKit/Tests/PhotoEncoderTests.swift:12"));
    await fireEvent.press(screen.getByText("Lumiform/Inspection/FormItem/Question/Signature/Inpection+DrawingData.swift:32"));
    await fireEvent.press(screen.getByText("LumiformTests/Extensions/UIImageResizedTests.swift"));
    expect(onOpen.mock.calls.map((c) => c[0])).toEqual([
      "Lumiform/Extensions/UIImage+Resized.swift",
      ".github/workflows/tests.yml",
      "Packages/PhotoImportKit/Tests/PhotoEncoderTests.swift",
      "Lumiform/Inspection/FormItem/Question/Signature/Inpection+DrawingData.swift",
      "LumiformTests/Extensions/UIImageResizedTests.swift",
    ]);
  });

  it("leaves code that is not a path as words", async () => {
    const onOpen = jest.fn();
    await render(<ReviewFilePage kicker="File 7 of 20" file={page()} verdicts={undefined} onOpen={onOpen} />);
    await fireEvent.press(screen.getByText("resizeWithCoreGraphics"));
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("opens a finding's line in its own file on a page of several files, which has no path of its own", async () => {
    const onOpen = jest.fn();
    await render(<ReviewFilePage kicker="File 3 of 20" file={page()} verdicts={undefined} onOpen={onOpen} />);
    await fireEvent.press(screen.getByText("line 10"));
    expect(onOpen).toHaveBeenCalledWith("Packages/PhotoImportKit/Tests/PhotoEncoderTests.swift");
  });
});
