"use client";

import { cn } from "@/lib/cn";
import { LOCALE_COOKIE, htmlLang, type Locale } from "@/lib/locale";
import { SEGMENTED } from "@/lib/tokens";

/**
 * A segmented pair rather than two standalone buttons.
 *
 * Language is a preference set once, so it should not carry the same visual
 * weight as the actions on the page. Grouping the options and giving only the
 * selected one a filled background says "this is a setting, and here is where
 * it currently stands" without competing with the primary controls.
 */
export function LocaleSwitch({
  locale,
  labels,
}: {
  locale: Locale;
  /**
   * The group's accessible name and the two option names, resolved by whoever
   * renders this.
   *
   * `components/shell.tsx` puts this switch in the header of every signed-in
   * page, so the shell's client graph is the layout's client graph. A `t()`
   * call here therefore reached `lib/i18n.ts` and pulled both message
   * catalogues — one 27.7 kB gzipped chunk — onto every route in the console,
   * including the ones that render no message of their own. Measured: with
   * this switch still looking keys up, fixing the other two banners the layout
   * mounts moved `/audit` by 0.0 kB.
   *
   * `LOCALE_COOKIE` and `htmlLang` stay imported and cost nothing: neither
   * reads `catalogs`, so with `sideEffects` declared in `package.json` webpack
   * drops the catalogues from this chunk while keeping them. That is measured
   * too, not assumed — see `lib/i18n.test.ts`.
   *
   * The two option names are the catalogue's own `header.langZh` and
   * `header.langEn`, unchanged. They are not written here, because a language
   * name typed into a component is a value that `scripts/check-i18n.mjs` can
   * no longer see.
   */
  labels: { language: string; zh: string; en: string };
}) {
  function setLocale(next: Locale) {
    if (next === locale) return;
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    document.documentElement.lang = htmlLang(next);
    // A reload rather than a router refresh: the locale is read on the server
    // from the cookie, so the whole tree has to be produced again.
    window.location.reload();
  }

  return (
    <div className={SEGMENTED.root} role="group" aria-label={labels.language}>
      {(["zh", "en"] as const).map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={locale === option}
          className={cn(SEGMENTED.option, locale === option ? SEGMENTED.optionSelected : undefined)}
          onClick={() => setLocale(option)}
        >
          {option === "zh" ? labels.zh : labels.en}
        </button>
      ))}
    </div>
  );
}
