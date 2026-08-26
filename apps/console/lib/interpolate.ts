/**
 * `{name}` substitution, in a module that imports no message catalogue.
 *
 * ## Why this is its own file
 *
 * `lib/i18n.ts` imports both `messages/zh.json` and `messages/en.json` at the
 * top level, and both are real runtime values (`catalogs`), not types. A
 * client component that imports *anything* from `lib/i18n.ts` therefore puts
 * the whole module in its client graph, and webpack can only drop the two
 * catalogues from that graph if every export it actually uses is reachable
 * without them.
 *
 * Three client components — `components/conversation.tsx`,
 * `components/proxy-manager.tsx`, `components/send-sms.tsx` — need only this
 * six-line function. They ask for it because the consequence sentences they
 * render are filled in per row (`{name}`, `{count}`, `{code}`), which is the
 * whole point of those sentences: a confirmation that names the row the
 * operator clicked. T012 measured what that import costs today — `/proxy`
 * went 116 kB → 132 kB First Load JS purely by importing `interpolate` from
 * `lib/i18n.ts` — and named the fix it was not allowed to make: this file,
 * plus a re-export from `lib/i18n.ts`.
 *
 * ## What this file may never grow
 *
 * No import of `messages/*.json`, and no import of `./i18n.ts`. The value of
 * the split is exactly that this module is reachable without the catalogues;
 * an import in either direction from here would put them back, silently, and
 * the only symptom would be a number in a build table nobody reads.
 * `lib/interpolate.test.ts` asserts that, on this file's source.
 *
 * ## Why the second implementation was not written instead
 *
 * T012 could have hand-written the same six lines inside the `.tsx` and saved
 * the same bytes. It declined, and was right to: a `.tsx` in this app cannot
 * be reached by a test, and a second interpolation implementation is a second
 * chance to get escaping wrong. One implementation, in `lib/`, tested.
 */

/**
 * Replace every `{name}` in `template` with `vars.name`.
 *
 * A placeholder with no matching variable is left standing as `{name}` rather
 * than blanked. That is deliberate: these templates are consequence text on
 * destructive controls, and a sentence that quietly loses its object ("this
 * removes  from the tenant") reads as finished while saying less than the
 * author wrote. `{name}` left in place reads as broken, which is what it is.
 *
 * `null` and `undefined` are treated the same way for the same reason. `0` and
 * `""` are not: they are values the caller meant to show.
 */
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
