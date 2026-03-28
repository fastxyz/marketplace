"use client";

import * as React from "react";

type Theme = "light" | "dark";

export interface ThemeProviderProps {
  children: React.ReactNode;
  attribute?: "class" | `data-${string}`;
  defaultTheme?: Theme | "system";
  disableTransitionOnChange?: boolean;
  enableSystem?: boolean;
  themes?: Theme[];
}

interface ThemeContextValue {
  resolvedTheme: Theme;
  setTheme: (theme: Theme) => void;
}

const ThemeContext = React.createContext<ThemeContextValue | undefined>(undefined);
const STORAGE_KEY = "theme";

function resolveSystemTheme(): Theme {
  if (typeof window === "undefined") {
    return "light";
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: Theme, attribute: ThemeProviderProps["attribute"]) {
  const root = document.documentElement;

  if (attribute === "class") {
    root.classList.toggle("dark", theme === "dark");
    root.classList.toggle("light", theme === "light");
  } else if (attribute) {
    root.setAttribute(attribute, theme);
  }

  root.style.colorScheme = theme;
}

function disableTransitionsTemporarily() {
  const style = document.createElement("style");
  style.appendChild(
    document.createTextNode(
      "*,*::before,*::after{-webkit-transition:none!important;-moz-transition:none!important;-o-transition:none!important;transition:none!important}"
    )
  );
  document.head.appendChild(style);

  return () => {
    window.getComputedStyle(document.body);
    window.setTimeout(() => {
      document.head.removeChild(style);
    }, 1);
  };
}

export function ThemeProvider({
  children,
  attribute = "class",
  defaultTheme = "light",
  disableTransitionOnChange = false,
  enableSystem = false
}: ThemeProviderProps) {
  const [resolvedTheme, setResolvedTheme] = React.useState<Theme>("light");

  React.useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY) as Theme | "system" | null;
    const nextTheme =
      stored === "light" || stored === "dark"
        ? stored
        : stored === "system" && enableSystem
        ? resolveSystemTheme()
        : defaultTheme === "system" && enableSystem
        ? resolveSystemTheme()
        : defaultTheme === "dark"
        ? "dark"
        : "light";

    setResolvedTheme(nextTheme);
    applyTheme(nextTheme, attribute);
  }, [attribute, defaultTheme, enableSystem]);

  React.useEffect(() => {
    if (!enableSystem) {
      return;
    }

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === "system" || (!stored && defaultTheme === "system")) {
        const nextTheme = resolveSystemTheme();
        setResolvedTheme(nextTheme);
        applyTheme(nextTheme, attribute);
      }
    };

    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, [attribute, defaultTheme, enableSystem]);

  const setTheme = React.useCallback(
    (theme: Theme) => {
      const cleanup = disableTransitionOnChange ? disableTransitionsTemporarily() : null;
      window.localStorage.setItem(STORAGE_KEY, theme);
      setResolvedTheme(theme);
      applyTheme(theme, attribute);
      cleanup?.();
    },
    [attribute, disableTransitionOnChange]
  );

  const value = React.useMemo<ThemeContextValue>(
    () => ({
      resolvedTheme,
      setTheme
    }),
    [resolvedTheme, setTheme]
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = React.useContext(ThemeContext);

  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider.");
  }

  return context;
}
