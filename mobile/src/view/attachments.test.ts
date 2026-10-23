import { bytesOf, fitLongEdge, IMAGE_BYTES, LONG_EDGE, MAX_IMAGES, photos } from "./attachments";

describe("making a picture small", () => {
  it("brings the longest side down to the limit and keeps the shape", () => {
    expect(fitLongEdge(4032, 3024)).toEqual({ width: LONG_EDGE, height: 1176 });
    expect(fitLongEdge(3024, 4032)).toEqual({ width: 1176, height: LONG_EDGE });
    expect(fitLongEdge(3000, 3000)).toEqual({ width: LONG_EDGE, height: LONG_EDGE });
    expect(fitLongEdge(4000, 1000, 1024)).toEqual({ width: 1024, height: 256 });
  });

  it("never makes a picture bigger, or does anything with one that has no size", () => {
    expect(fitLongEdge(800, 600)).toBeNull();
    expect(fitLongEdge(LONG_EDGE, 10)).toBeNull();
    expect(fitLongEdge(0, 0)).toBeNull();
    expect(fitLongEdge(NaN, 100)).toBeNull();
  });

  it("keeps a very thin picture at least one pixel on its short side", () => {
    expect(fitLongEdge(10_000, 1)).toEqual({ width: LONG_EDGE, height: 1 });
  });

  it("weighs a base64 string", () => {
    expect(bytesOf("")).toBe(0);
    expect(bytesOf("QQ==")).toBe(1);
    expect(bytesOf("QUI=")).toBe(2);
    expect(bytesOf("QUJD")).toBe(3);
  });

  it("keeps four pictures inside the 5 MB the Mac takes", () => {
    expect(MAX_IMAGES * IMAGE_BYTES).toBeLessThan(5 << 20);
  });

  it("says how many photos", () => {
    expect([photos(1), photos(2), photos(4)]).toEqual(["1 photo", "2 photos", "4 photos"]);
  });
});
