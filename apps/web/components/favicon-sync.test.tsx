// @vitest-environment jsdom

import React from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FaviconSync } from "./favicon-sync";

describe("FaviconSync", () => {
  let prefersDark = false;

  beforeEach(() => {
    document.head.innerHTML = "";
    prefersDark = false;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: (query: string) => ({
        matches: query === "(prefers-color-scheme: dark)" ? prefersDark : false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        dispatchEvent: () => false
      })
    });
  });

  afterEach(() => {
    cleanup();
    document.head.innerHTML = "";
  });

  it("uses the light favicon when the browser prefers dark mode", async () => {
    prefersDark = true;

    render(<FaviconSync />);

    await waitFor(() => {
      expect(document.head.querySelector('link[rel="icon"]')?.getAttribute("href")).toBe("/brand/favicon_light.ico");
    });
  });

  it("uses the dark favicon when the browser prefers light mode", async () => {
    render(<FaviconSync />);

    await waitFor(() => {
      expect(document.head.querySelector('link[rel="icon"]')?.getAttribute("href")).toBe("/brand/favicon_dark.ico");
    });
  });
});
