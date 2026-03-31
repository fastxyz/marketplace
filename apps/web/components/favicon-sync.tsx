"use client";

import * as React from "react";

import { useTheme } from "@/components/theme-provider";

const FAVICON_BY_THEME = {
  dark: "/brand/favicon_light.ico",
  light: "/brand/favicon_dark.ico"
} as const;

const LINK_RELS = ["icon", "shortcut icon"] as const;

function updateFaviconLinks(href: string) {
  for (const rel of LINK_RELS) {
    const existing = document.head.querySelectorAll<HTMLLinkElement>(`link[rel="${rel}"]`);

    if (existing.length === 0) {
      const link = document.createElement("link");
      link.rel = rel;
      link.type = "image/x-icon";
      link.href = href;
      document.head.appendChild(link);
      continue;
    }

    for (const link of existing) {
      link.type = "image/x-icon";
      link.href = href;
    }
  }
}

export function FaviconSync() {
  const { resolvedTheme } = useTheme();

  React.useEffect(() => {
    const theme = resolvedTheme === "dark" ? "dark" : "light";
    updateFaviconLinks(FAVICON_BY_THEME[theme]);
  }, [resolvedTheme]);

  return null;
}
