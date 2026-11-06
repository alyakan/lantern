import { describe, expect, it } from "vitest";
import { fitted, imagesIn, imageToken, nextImage, type PastedImage } from "./images";

const a: PastedImage = { media_type: "image/png", data: "AAA" };
const b: PastedImage = { media_type: "image/jpeg", data: "BBB" };

describe("pasted pictures", () => {
  it("are numbered past the highest in the box or kept", () => {
    expect(nextImage("", {})).toBe(1);
    expect(nextImage(`look ${imageToken(1)}`, { 1: a })).toBe(2);
    expect(nextImage("", { 3: a })).toBe(4);
  });

  it("go in the order the box shows them, and only while their token is still there", () => {
    expect(imagesIn("[Image #2] then [Image #1]", { 1: a, 2: b })).toEqual([b, a]);
    expect(imagesIn("only [Image #2]", { 1: a, 2: b })).toEqual([b]);
    expect(imagesIn("[Image #1] and again [Image #1]", { 1: a })).toEqual([a]);
    expect(imagesIn("[Image #9]", { 1: a })).toEqual([]);
  });

  it("are scaled so the long side is at most 1568", () => {
    expect(fitted(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitted(3024, 1964)).toEqual({ width: 1568, height: 1018 });
    expect(fitted(1000, 4000)).toEqual({ width: 392, height: 1568 });
  });
});
