import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";
import {
  TAILWIND_BORDER_RADIUS,
  TAILWIND_COLORS,
  TAILWIND_SPACING,
} from "./tokens.ts";

/**
 * Join class names, letting the last one win.
 *
 * The second half matters more than it looks. A shared component that renders
 * `class="p-s4"` and is handed `className="p-s2"` emits both, and CSS then
 * resolves the conflict by *stylesheet* order, not by call order — so the
 * caller's override loses whenever Tailwind happens to emit `p-s4` later.
 * `tailwind-merge` drops the earlier of two classes that set the same
 * property, which is what makes `<Card className="p-s2">` mean anything.
 *
 * It has to be told about the scales, because it recognises conflicts by
 * pattern: `p-4` is a padding class because `4` looks like a number, and
 * `p-s4` does not. Feeding it the token keys is the whole reason this is
 * `extendTailwindMerge` rather than the bare `twMerge`, and
 * `tokens.test.ts` checks that an override actually overrides — a silent
 * misconfiguration here looks exactly like working code.
 */

const SPACING_KEYS = Object.keys(TAILWIND_SPACING);
const RADIUS_KEYS = Object.keys(TAILWIND_BORDER_RADIUS).filter((key) => key !== "DEFAULT");
const COLOR_KEYS = Object.keys(TAILWIND_COLORS);

const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      spacing: SPACING_KEYS,
      padding: SPACING_KEYS,
      margin: SPACING_KEYS,
      gap: SPACING_KEYS,
      inset: SPACING_KEYS,
      space: SPACING_KEYS,
      translate: SPACING_KEYS,
      borderRadius: RADIUS_KEYS,
      borderSpacing: SPACING_KEYS,
      colors: COLOR_KEYS,
      borderColor: COLOR_KEYS,
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
