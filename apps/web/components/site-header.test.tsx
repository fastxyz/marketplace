// @vitest-environment jsdom

import React from "react";
import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { SiteHeader } from "./site-header";

const { useThemeMock } = vi.hoisted(() => ({
  useThemeMock: vi.fn(() => ({
    resolvedTheme: "light",
    setTheme: vi.fn()
  }))
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  )
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/"
}));

vi.mock("@/components/theme-provider", () => ({
  useTheme: () => useThemeMock()
}));

describe("SiteHeader", () => {
  it("renders desktop navigation plus the wallet login controls", () => {
    render(
      <SiteHeader
        apiBaseUrl="https://api.marketplace.example.com"
        deploymentNetwork="testnet"
        networkLabel="Testnet"
      />
    );

    expect(screen.getByRole("link", { name: /fast marketplace/i }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("navigation")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Marketplace" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Stats" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Spend" })).toBeTruthy();
    expect(screen.getByText("Testnet")).toBeTruthy();
    expect(screen.getByRole("button", { name: /toggle color theme/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /connect to fast/i })).toBeTruthy();
  });

  it("renders the site links directly in the shared shell", () => {
    render(
      <SiteHeader
        apiBaseUrl="https://api.marketplace.example.com"
        deploymentNetwork="testnet"
        networkLabel="Testnet"
      />
    );

    const nav = screen.getAllByRole("navigation")[0];
    expect(within(nav).getByText("Marketplace")).toBeTruthy();
    expect(within(nav).getByText("Stats")).toBeTruthy();
    expect(within(nav).getByText("Spend")).toBeTruthy();
    expect(within(nav).getByText("Suggest")).toBeTruthy();
    expect(within(nav).getByText("Providers")).toBeTruthy();
    expect(within(nav).getByText("SKILL.md")).toBeTruthy();
  });

  it("does not render the mainnet badge in the navbar", () => {
    render(
      <SiteHeader
        apiBaseUrl="https://api.marketplace.example.com"
        deploymentNetwork="mainnet"
        networkLabel="Mainnet"
      />
    );

    expect(screen.queryByText("Mainnet")).toBeNull();
  });
});
