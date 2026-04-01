"use client";

import * as React from "react";

type Theme = "light" | "dark";

type ThemeContextValue = {
  resolvedTheme: Theme;
  setTheme: (theme: Theme) => void;
};

const STORAGE_KEY = "fast-marketplace-theme";

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

function readStoredTheme(defaultTheme: Theme): Theme {
  const storedTheme = window.localStorage.getItem(STORAGE_KEY);
  return storedTheme === "dark" || storedTheme === "light" ? storedTheme : defaultTheme;
}

export function ThemeProvider({
  children,
  defaultTheme = "light"
}: {
  children: React.ReactNode;
  defaultTheme?: Theme;
}) {
  const [resolvedTheme, setResolvedTheme] = React.useState<Theme>(defaultTheme);

  React.useEffect(() => {
    const initialTheme = readStoredTheme(defaultTheme);
    setResolvedTheme(initialTheme);
    applyTheme(initialTheme);
  }, [defaultTheme]);

  const setTheme = React.useCallback((theme: Theme) => {
    setResolvedTheme(theme);
    window.localStorage.setItem(STORAGE_KEY, theme);
    applyTheme(theme);
  }, []);

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
    throw new Error("useTheme must be used within ThemeProvider");
  }

  return context;
}
