"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

type Theme = "dark" | "light";

const STORAGE_KEY = "vodoge.theme";

/**
 * Repoints the status bar at the background now on screen.
 *
 * The colour is read back out of the stylesheet rather than written here, so
 * `--bg` keeps exactly one definition and the bar cannot fall a palette
 * behind. Custom properties are not interpolated by the `all` shorthand that
 * `body` carries, so this reads the value that has just been applied rather
 * than the one being animated away from — the trap that makes a freshly
 * flipped theme look like it never took effect.
 */
function paintStatusBar(root: HTMLElement): void {
  const meta = document.querySelector('meta[name="theme-color"]');
  const background = getComputedStyle(root).getPropertyValue("--bg").trim();
  if (meta && background) meta.setAttribute("content", background);
}

/**
 * Switches between the two themes and remembers the choice.
 *
 * The initial value is read in an effect rather than during render: the server
 * cannot know what is in localStorage, and reading it while rendering makes the
 * markup disagree with the DOM on the first paint.
 *
 * The price of that is paid in daylight and is worth naming, because it looks
 * like a bug and is not one. Nothing applies the theme until this effect runs,
 * so the first painted frame is always the dark theme; a reader on the light
 * one watches the page repaint. Measured on a signed-in page, the first frame
 * carries no `data-theme` at all and `--bg` is `#010102`, and `dynamic =
 * "force-dynamic"` in `app/layout.tsx` means that happens on every load rather
 * than only the first. It is a deliberate trade against a hydration mismatch,
 * and it was reviewed and kept on 2026-08-26; `docs/goals/vodoge-ui-refactor/
 * notes/T047-T048-theme-boot.md` records both sides and what to check first if
 * anyone reopens it.
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
    const root = document.documentElement;
    root.dataset.theme = theme;
    window.localStorage.setItem(STORAGE_KEY, theme);
    // The status bar is a second surface showing the same background, and it
    // has to move when the background does.
    paintStatusBar(root);
  }, [theme]);

  const next: Theme = theme === "light" ? "dark" : "light";

  return (
    <Button
      variant="subtle"
      size="icon"
      title={labels.toggle}
      aria-label={`${labels.toggle}: ${next === "dark" ? labels.dark : labels.light}`}
      onClick={() => setTheme(next)}
    >
      {/* Rendered only once the stored choice is known, so the icon never
          flips on hydration. */}
      {theme === null ? "" : theme === "dark" ? "☾" : "☀"}
    </Button>
  );
}
