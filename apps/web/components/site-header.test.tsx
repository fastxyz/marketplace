// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
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
  it("renders navigation plus the wallet login controls", () => {
    render(
      <SiteHeader
        apiBaseUrl="https://api.marketplace.example.com"
        deploymentNetwork="testnet"
        networkLabel="Testnet"
      />
    );

    expect(screen.getByRole("link", { name: /fast marketplace/i }).getAttribute("href")).toBe("/");
    expect(screen.getByText("Marketplace")).toBeTruthy();
    expect(screen.getByText("Stats")).toBeTruthy();
    expect(screen.getByText("Providers")).toBeTruthy();
    expect(screen.getByText("SKILL.md")).toBeTruthy();
    expect(screen.getByText("Testnet")).toBeTruthy();
    expect(screen.getByRole("button", { name: /toggle color theme/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /connect wallet/i })).toBeTruthy();
  });
});
