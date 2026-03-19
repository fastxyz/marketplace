import { describe, expect, it } from "vitest";

import { metadata } from "./layout";

describe("root layout metadata", () => {
  it("includes social preview metadata for the shared screenshot", () => {
    expect(metadata.metadataBase).toBeInstanceOf(URL);
    expect(metadata.openGraph?.images).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: "/brand/screenshot.png"
        })
      ])
    );
    expect(metadata.twitter?.images).toEqual(expect.arrayContaining(["/brand/screenshot.png"]));
  });
});
