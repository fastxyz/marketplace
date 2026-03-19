// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { SiteFooter } from "./site-footer";

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => (
    <a href={href} {...props}>
      {children}
    </a>
  )
}));

describe("SiteFooter", () => {
  it("renders the public suggestion links", () => {
    render(<SiteFooter />);

    expect(screen.getByRole("link", { name: "Providers" }).getAttribute("href")).toBe("/providers");
    expect(screen.getByRole("link", { name: "Suggest an endpoint" }).getAttribute("href")).toBe(
      "/suggest?type=endpoint"
    );
    expect(screen.getByRole("link", { name: "Suggest a source" }).getAttribute("href")).toBe(
      "/suggest?type=source"
    );
  });
});
