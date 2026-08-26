import { interpolate } from "./interpolate.ts";
import { DEFAULT_LOCALE, type Locale } from "./locale.ts";
import en from "../messages/en.json" with { type: "json" };
import zh from "../messages/zh.json" with { type: "json" };

/**
 * A key both catalogues have.
 *
 * The intersection is the guard: adding a key to `zh.json` alone does not
 * widen `MessageKey`, so the first `t("device.newThing")` that names it is a
 * type error rather than a `⟦device.newThing⟧` an English-speaking operator
 * discovers in production. `scripts/check-i18n.mjs` catches the same defect
 * from the other side, at runtime, including for keys reached by lookup that
 * no literal in the source names. Both are wanted; neither subsumes the other.
 *
 * This is why the two JSON imports above stay static. A dynamic import, or a
 * `readFileSync`, would make the catalogues invisible to the type system and
 * cost this guard — see `lib/interpolate.test.ts`, which fails if the
 * intersection is replaced by a union or by `string`.
 */
export type MessageKey = keyof typeof zh & keyof typeof en;

export const catalogs: Record<Locale, Record<MessageKey, string>> = { zh, en };
export const LOCALES: readonly Locale[] = ["zh", "en"];
export const MISSING_KEY_PATTERN = /^⟦.+⟧$/;

/**
 * Re-exported so every existing `from "@/lib/i18n"` keeps working unchanged.
 *
 * These five moved to `lib/locale.ts` for the reason that file documents: the
 * catalogues above are welded to *this module*, so a client component that
 * imported `LOCALE_COOKIE` or `htmlLang` from here downloaded 27.7 kB of
 * gzipped message catalogue to learn a cookie's name. Forwarding through a
 * re-export is what lets webpack resolve the specifier to a module with no
 * catalogue in it and leave this one out of the chunk — the same mechanism
 * `interpolate` below relies on, and the reason both live in separate files
 * rather than being exported from here directly.
 *
 * `components/locale-switch.tsx` deliberately imports from `@/lib/locale`
 * instead of going through this line, because it is the one client component
 * the root layout mounts on every route: the shorter the path between it and
 * the catalogues, the fewer ways a future edit can reconnect them.
 */
export type { Locale } from "./locale.ts";
export { DEFAULT_LOCALE, LOCALE_COOKIE, htmlLang, isLocale } from "./locale.ts";

/**
 * Re-exported so that `import { interpolate } from "@/lib/i18n"` keeps working
 * for the callers that already write it, while the function itself lives in a
 * module that pulls in no catalogue.
 *
 * The re-export is not decoration: with `sideEffects` declared in
 * `package.json`, webpack resolves this specifier straight through to
 * `lib/interpolate.ts`, finds nothing else in this module used, and leaves
 * both catalogues out of the importing chunk. `lib/interpolate.test.ts`
 * measures that, so the day someone deletes the re-export and moves the body
 * back here, a test says so instead of a build table.
 */
export { interpolate };

/**
 * Missing keys render as ⟦key⟧ so they are visible in the UI and in tests.
 * Do not silently fall back to the other locale.
 */
export function t(
  key: MessageKey | (string & {}),
  locale: Locale = DEFAULT_LOCALE,
  vars?: Record<string, string | number>,
): string {
  const table = catalogs[locale];
  const template = table[key as MessageKey];
  if (typeof template !== "string") {
    return `⟦${key}⟧`;
  }
  return interpolate(template, vars);
}

export function catalogKeyList(catalog: Record<string, string>): string[] {
  return Object.keys(catalog).sort();
}

export function diffCatalogKeys(
  left: Record<string, string>,
  right: Record<string, string>,
): { missingInRight: string[]; missingInLeft: string[] } {
  const leftKeys = new Set(Object.keys(left));
  const rightKeys = new Set(Object.keys(right));
  return {
    missingInRight: [...leftKeys].filter((key) => !rightKeys.has(key)).sort(),
    missingInLeft: [...rightKeys].filter((key) => !leftKeys.has(key)).sort(),
  };
}
