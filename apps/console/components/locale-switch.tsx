"use client";

import { LOCALE_COOKIE, htmlLang, t, type Locale } from "@/lib/i18n";

export function LocaleSwitch({ locale }: { locale: Locale }) {
  function setLocale(next: Locale) {
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    document.documentElement.lang = htmlLang(next);
    window.location.reload();
  }

  return (
    <div className="locale-switch" role="group" aria-label={t("header.language", locale)}>
      <button type="button" aria-pressed={locale === "zh"} onClick={() => setLocale("zh")}>
        {t("header.langZh", locale)}
      </button>
      <button type="button" aria-pressed={locale === "en"} onClick={() => setLocale("en")}>
        {t("header.langEn", locale)}
      </button>
    </div>
  );
}
