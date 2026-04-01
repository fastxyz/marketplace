import React from "react";
import Link from "next/link";
import { Linkedin } from "lucide-react";

import { FastLogo } from "@/components/fast-logo";

const socialLinks = [
  { href: "https://x.com/pi2_labs", label: "X.com" },
  { href: "https://www.linkedin.com/company/fast-xyz", label: "LinkedIn" }
];

export function SiteFooter() {
  return (
    <footer className="border-t border-border/80 text-foreground">
      <div className="footer-shell py-6">
        <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
          <div className="text-foreground">
            <FastLogo height={16} />
          </div>
          <div className="flex items-center gap-5">
            <Link
              href={socialLinks[0].href}
              className="footer-link text-muted-foreground transition-colors hover:text-foreground"
              target="_blank"
              rel="noreferrer"
              aria-label={socialLinks[0].label}
              title={socialLinks[0].label}
            >
              <XIcon className="h-4 w-4" />
            </Link>
            <Link
              href={socialLinks[1].href}
              className="footer-link text-muted-foreground transition-colors hover:text-foreground"
              target="_blank"
              rel="noreferrer"
              aria-label={socialLinks[1].label}
              title={socialLinks[1].label}
            >
              <Linkedin className="h-4 w-4" />
            </Link>
          </div>
          <p className="text-sm text-muted-foreground">© {new Date().getFullYear()} Fast Marketplace</p>
        </div>
      </div>
    </footer>
  );
}

function XIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className={className}
    >
      <path
        d="M5 4L19 20M19 4L5 20"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
