// @vitest-environment jsdom

import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { SiteHeader } from "./site-header";
import { ThemeProvider } from "./theme-provider";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  )
}));

describe("SiteHeader", () => {
  function renderHeader(deploymentNetwork: "testnet" | "mainnet", networkLabel: string) {
    return render(
      <ThemeProvider defaultTheme="light">
        <SiteHeader
          apiBaseUrl="https://api.marketplace.example.com"
          deploymentNetwork={deploymentNetwork}
          networkLabel={networkLabel}
        />
      </ThemeProvider>
    );
  }

  it("renders desktop navigation plus the wallet login controls", () => {
    renderHeader("testnet", "Testnet");

    expect(screen.getByRole("link", { name: /fast marketplace/i }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("navigation")).toBeTruthy();
    expect(screen.getByRole("button", { name: /open navigation menu/i })).toBeTruthy();
    expect(screen.getByText("Testnet")).toBeTruthy();
    expect(screen.getByRole("button", { name: /toggle color theme/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /connect to fast/i })).toBeTruthy();
  });

  it("shows the site links inside the mobile burger menu", async () => {
    const user = userEvent.setup();

    renderHeader("testnet", "Testnet");

    expect(screen.queryByRole("navigation", { name: "Mobile" })).toBeNull();

    await user.click(screen.getAllByRole("button", { name: /open navigation menu/i })[0]);

    const mobileNav = screen.getByRole("navigation", { name: "Mobile" });
    expect(mobileNav).toBeTruthy();
    expect(within(mobileNav).getByText("Stats")).toBeTruthy();
    expect(within(mobileNav).getByText("Spend")).toBeTruthy();
    expect(within(mobileNav).getByText("Providers")).toBeTruthy();
  });

  it("does not render the mainnet badge in the navbar", () => {
    renderHeader("mainnet", "Mainnet");

    expect(screen.queryByText("Mainnet")).toBeNull();
  });
});
