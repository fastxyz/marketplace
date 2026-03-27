// @vitest-environment jsdom

import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { SiteHeader } from "./site-header";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  )
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
    expect(screen.getByRole("button", { name: /open navigation menu/i })).toBeTruthy();
    expect(screen.getByText("Testnet")).toBeTruthy();
    expect(screen.getByRole("button", { name: /toggle color theme/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /connect to fast/i })).toBeTruthy();
  });

  it("shows the site links inside the mobile burger menu", async () => {
    const user = userEvent.setup();

    render(
      <SiteHeader
        apiBaseUrl="https://api.marketplace.example.com"
        deploymentNetwork="testnet"
        networkLabel="Testnet"
      />
    );

    expect(screen.queryByRole("navigation", { name: "Mobile" })).toBeNull();

    await user.click(screen.getAllByRole("button", { name: /open navigation menu/i })[0]);

    const mobileNav = screen.getByRole("navigation", { name: "Mobile" });
    expect(mobileNav).toBeTruthy();
    expect(within(mobileNav).getByText("Marketplace")).toBeTruthy();
    expect(within(mobileNav).getByText("Stats")).toBeTruthy();
    expect(within(mobileNav).getByText("Spend")).toBeTruthy();
    expect(within(mobileNav).getByText("Suggest")).toBeTruthy();
    expect(within(mobileNav).getByText("Providers")).toBeTruthy();
    expect(within(mobileNav).getByText("SKILL.md")).toBeTruthy();
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
