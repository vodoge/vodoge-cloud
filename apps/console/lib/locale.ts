/**
 * Which language, in a module that imports no message catalogue.
 *
 * ## Why this is its own file, and not five more exports in `lib/i18n.ts`
 *
 * `lib/i18n.ts` imports `messages/zh.json` and `messages/en.json` at the top
 * level and keeps them as a runtime value (`catalogs`). Webpack therefore ties
 * the catalogues to *that module*, not to the exports that read them: a client
 * component importing any binding declared in `lib/i18n.ts` pulls the whole
 * module into its chunk, and both catalogues ride along — one 76.8 kB chunk,
 * 27.7 kB gzipped — even when the binding it wanted was a nine-character
 * cookie name.
 *
 * This is the part T039 left unstated, and it is worth stating because the
 * obvious repair is the one that does not work. T039 fixed the same problem
 * for `interpolate` and recorded the fix as "split it out, and declare
 * `sideEffects`". The reason splitting was required — rather than simply
 * exporting the function from `lib/i18n.ts` and letting tree shaking do the
 * rest — is that `sideEffects` lets webpack drop an unreached *module*, and
 * only a re-export that forwards to a catalogue-free module gives it one to
 * drop. An in-module binding never gets that treatment, however unused the
 * catalogues are on that path.
 *
 * Measured on this tree, which is the only reason this file exists:
 * `components/locale-switch.tsx` needs exactly `LOCALE_COOKIE` and `htmlLang`.
 * With those two declared in `lib/i18n.ts`, taking `t()` out of all three
 * client components the root layout mounts moved `/audit` from 150.2 kB to
 * 150.1 kB gzipped — 0.1 kB, for a change that removed every catalogue lookup
 * from the layout's client graph. The literal `vodoge.locale` was sitting in
 * the catalogue chunk itself. The import edge was the weight, not the code.
 *
 * ## What this file may never grow
 *
 * No import of `messages/*.json`, and no import of `./i18n.ts`. Either one
 * re-attaches the catalogues to every route in the console and silently undoes
 * the measurement above. `lib/i18n.test.ts` fails if this file imports
 * anything at all.
 *
 * Everything here is re-exported from `lib/i18n.ts`, so no existing call site
 * changed and `import { LOCALE_COOKIE } from "@/lib/i18n"` keeps working.
 */

export type Locale = "zh" | "en";

export const DEFAULT_LOCALE: Locale = "zh";

/**
 * The one place this cookie's name is written.
 *
 * `lib/request-locale.ts` reads it on the server and
 * `components/locale-switch.tsx` writes it in the browser. Copying the literal
 * into either of them to dodge an import would make this the sort of
 * hand-copied pair `app/layout.tsx` already warns about for the theme colour:
 * a second place a change has to be remembered, and found later by someone
 * whose language preference stopped surviving a reload.
 */
export const LOCALE_COOKIE = "vodoge.locale";

export function isLocale(value: string | undefined | null): value is Locale {
  return value === "zh" || value === "en";
}

/**
 * The `lang` attribute for a locale.
 *
 * `zh` becomes `zh-CN` rather than `zh`, because the console is written in
 * Simplified Chinese and a bare `zh` leaves the choice of script to the
 * client.
 */
export function htmlLang(locale: Locale): string {
  return locale === "en" ? "en" : "zh-CN";
}
