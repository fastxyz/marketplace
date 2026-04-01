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
  it("renders only the social links", () => {
    render(<SiteFooter />);

    const links = screen.getAllByRole("link");

    expect(links).toHaveLength(2);
    expect(screen.getByRole("link", { name: "X.com" }).getAttribute("href")).toBe("https://x.com/pi2_labs");
    expect(screen.getByRole("link", { name: "LinkedIn" }).getAttribute("href")).toBe(
      "https://www.linkedin.com/company/fast-xyz"
    );
  });
});
