import en from "../messages/en.json" with { type: "json" };
import zh from "../messages/zh.json" with { type: "json" };

export type Locale = "zh" | "en";
export type MessageKey = keyof typeof zh & keyof typeof en;

export const catalogs: Record<Locale, Record<MessageKey, string>> = { zh, en };
export const LOCALES: readonly Locale[] = ["zh", "en"];
export const DEFAULT_LOCALE: Locale = "zh";
export const LOCALE_COOKIE = "vodoge.locale";
export const MISSING_KEY_PATTERN = /^⟦.+⟧$/;

export function isLocale(value: string | undefined | null): value is Locale {
  return value === "zh" || value === "en";
}

export function htmlLang(locale: Locale): string {
  return locale === "en" ? "en" : "zh-CN";
}

export function interpolate(
  template: string,
  vars?: Record<string, string | number>,
): string {
  if (!vars) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    vars[name] == null ? `{${name}}` : String(vars[name]),
  );
}

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
