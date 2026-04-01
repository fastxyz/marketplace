"use client";

import * as React from "react";

const FAVICON_BY_THEME = {
  dark: "/brand/favicon_light.ico",
  light: "/brand/favicon_dark.ico"
} as const;

const LINK_RELS = ["icon", "shortcut icon"] as const;
const DARK_MODE_MEDIA_QUERY = "(prefers-color-scheme: dark)";

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

function resolvePreferredTheme(): keyof typeof FAVICON_BY_THEME {
  return window.matchMedia(DARK_MODE_MEDIA_QUERY).matches ? "dark" : "light";
}

export function FaviconSync() {
  React.useEffect(() => {
    const mediaQuery = window.matchMedia(DARK_MODE_MEDIA_QUERY);
    const syncFavicon = () => updateFaviconLinks(FAVICON_BY_THEME[resolvePreferredTheme()]);

    syncFavicon();
    mediaQuery.addEventListener("change", syncFavicon);

    return () => {
      mediaQuery.removeEventListener("change", syncFavicon);
    };
  }, []);

  return null;
}
