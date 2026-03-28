// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ModeToggle } from "./mode-toggle";

const { useThemeMock } = vi.hoisted(() => ({
  useThemeMock: vi.fn()
}));

vi.mock("@/components/theme-provider", () => ({
  useTheme: () => useThemeMock()
}));

describe("ModeToggle", () => {
  beforeEach(() => {
    useThemeMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("switches from light to dark", async () => {
    const setTheme = vi.fn();
    useThemeMock.mockReturnValue({
      resolvedTheme: "light",
      setTheme
    });

    render(<ModeToggle />);

    await userEvent.click(screen.getByRole("button", { name: /toggle color theme/i }));

    expect(setTheme).toHaveBeenCalledWith("dark");
  });

  it("switches from dark to light", async () => {
    const setTheme = vi.fn();
    useThemeMock.mockReturnValue({
      resolvedTheme: "dark",
      setTheme
    });

    render(<ModeToggle />);

    await userEvent.click(screen.getByRole("button", { name: /toggle color theme/i }));

    expect(setTheme).toHaveBeenCalledWith("light");
  });
});
