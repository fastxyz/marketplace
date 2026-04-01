// @vitest-environment jsdom

import React from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FaviconSync } from "./favicon-sync";
import { ThemeProvider } from "./theme-provider";

describe("FaviconSync", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
    window.localStorage.clear();
    document.documentElement.className = "";
  });

  afterEach(() => {
    cleanup();
    document.head.innerHTML = "";
  });

  it("uses the light favicon when the site theme is dark", async () => {
    window.localStorage.setItem("fast-marketplace-theme", "dark");

    render(
      <ThemeProvider defaultTheme="light">
        <FaviconSync />
      </ThemeProvider>
    );

    await waitFor(() => {
      expect(document.head.querySelector('link[rel="icon"]')?.getAttribute("href")).toBe("/brand/favicon_light.ico");
    });
  });

  it("uses the dark favicon when the site theme is light", async () => {
    render(
      <ThemeProvider defaultTheme="light">
        <FaviconSync />
      </ThemeProvider>
    );

    await waitFor(() => {
      expect(document.head.querySelector('link[rel="icon"]')?.getAttribute("href")).toBe("/brand/favicon_dark.ico");
    });
  });
});
