"use client";

import { LOCALE_COOKIE, htmlLang, t, type Locale } from "@/lib/i18n";

/**
 * A segmented pair rather than two standalone buttons.
 *
 * Language is a preference set once, so it should not carry the same visual
 * weight as the actions on the page. Grouping the options and giving only the
 * selected one a filled background says "this is a setting, and here is where
 * it currently stands" without competing with the primary controls.
 */
export function LocaleSwitch({ locale }: { locale: Locale }) {
  function setLocale(next: Locale) {
    if (next === locale) return;
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    document.documentElement.lang = htmlLang(next);
    // A reload rather than a router refresh: the locale is read on the server
    // from the cookie, so the whole tree has to be produced again.
    window.location.reload();
  }

  return (
    <div className="segmented" role="group" aria-label={t("header.language", locale)}>
      {(["zh", "en"] as const).map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={locale === option}
          onClick={() => setLocale(option)}
        >
          {option === "zh" ? t("header.langZh", locale) : t("header.langEn", locale)}
        </button>
      ))}
    </div>
  );
}
