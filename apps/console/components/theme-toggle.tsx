"use client";

import { useEffect, useState } from "react";

type Theme = "dark" | "light";

const STORAGE_KEY = "vodoge.theme";

/**
 * Switches between the two themes and remembers the choice.
 *
 * The initial value is read in an effect rather than during render: the server
 * cannot know what is in localStorage, and reading it while rendering makes the
 * markup disagree with the DOM on the first paint.
 */
export function ThemeToggle({
  labels,
}: {
  labels: { toggle: string; dark: string; light: string };
}) {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    const initial: Theme =
      stored === "light" || stored === "dark"
        ? stored
        : window.matchMedia("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark";
    setTheme(initial);
  }, []);

  useEffect(() => {
    if (!theme) return;
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  const next: Theme = theme === "light" ? "dark" : "light";

  return (
    <button
      type="button"
      className="subtle"
      title={labels.toggle}
      aria-label={`${labels.toggle}: ${next === "dark" ? labels.dark : labels.light}`}
      onClick={() => setTheme(next)}
    >
      {/* Rendered only once the stored choice is known, so the icon never
          flips on hydration. */}
      {theme === null ? "" : theme === "dark" ? "☾" : "☀"}
    </button>
  );
}
