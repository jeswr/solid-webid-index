// AUTHORED-BY Claude Opus 4.8 (Fable unavailable) — re-review/upgrade candidate
"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type * as React from "react";

/**
 * App-wide theme provider. OS `prefers-color-scheme` sets the default;
 * the header toggle writes a manual override (color-mode-and-theme skill).
 */
export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props}>{children}</NextThemesProvider>;
}
