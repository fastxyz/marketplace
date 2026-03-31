import React from "react";
import Link from "next/link";

import { FastLogo } from "@/components/fast-logo";

const socialLinks = [
  { href: "https://x.com/pi2_labs", label: "X.com" },
  { href: "https://www.linkedin.com/company/fast-xyz", label: "LinkedIn" }
];

export function SiteFooter() {
  return (
    <footer style={{ borderTop: "1px solid rgba(0,0,0,0.05)" }}>
      <div className="footer-shell py-6">
        <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
          <FastLogo height={16} fill="#2B2C2F" />
          <div className="flex items-center gap-5">
            <span className="footer-label">Socials</span>
            {socialLinks.map((link) => (
              <Link key={link.href} href={link.href} className="footer-link text-sm" target="_blank" rel="noreferrer">
                {link.label}
              </Link>
            ))}
          </div>
          <p className="text-sm text-muted-foreground">© {new Date().getFullYear()} Fast Marketplace</p>
        </div>
      </div>
    </footer>
  );
}
