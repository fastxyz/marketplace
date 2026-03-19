// @vitest-environment jsdom

import React from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FaviconSync } from "./favicon-sync";

const { useThemeMock } = vi.hoisted(() => ({
  useThemeMock: vi.fn()
}));

vi.mock("next-themes", () => ({
  useTheme: () => useThemeMock()
}));

describe("FaviconSync", () => {
  beforeEach(() => {
    useThemeMock.mockReset();
    document.head.innerHTML = "";
  });

  afterEach(() => {
    cleanup();
    document.head.innerHTML = "";
  });

  it("uses the light favicon when the site theme is dark", async () => {
    useThemeMock.mockReturnValue({
      resolvedTheme: "dark"
    });

    render(<FaviconSync />);

    await waitFor(() => {
      expect(document.head.querySelector('link[rel="icon"]')?.getAttribute("href")).toBe("/brand/favicon_light.ico");
    });
  });

  it("uses the dark favicon when the site theme is light", async () => {
    useThemeMock.mockReturnValue({
      resolvedTheme: "light"
    });

    render(<FaviconSync />);

    await waitFor(() => {
      expect(document.head.querySelector('link[rel="icon"]')?.getAttribute("href")).toBe("/brand/favicon_dark.ico");
    });
  });
});
