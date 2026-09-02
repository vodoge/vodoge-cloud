import { LocaleSwitch } from "@/components/locale-switch";
import { DEFAULT_BASE_DOMAIN, OPERATOR_SLUG } from "@/lib/host";
import { t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";
import { CENTERED } from "@/lib/tokens";

/** What the parent domain serves. Same shape as `not-found.tsx`; see its note
 *  about `.centered`, which has never existed in the stylesheet. */
export default async function NotATenantPage() {
  const locale = await getRequestLocale();
  const domain = process.env.VODOGE_BASE_DOMAIN?.trim() || DEFAULT_BASE_DOMAIN;

  return (
    <div className={CENTERED.root}>
      <div className={CENTERED.card}>
        <div>
          <h1 className="m-0 text-xl font-semibold tracking-tight text-foreground">{t("apex.title", locale)}</h1>
          <p className="m-0 mt-1 text-sm text-muted-foreground">
            {t("apex.body", locale, { slug: OPERATOR_SLUG, domain })}
          </p>
        </div>
        <LocaleSwitch
          locale={locale}
          labels={{
            language: t("header.language", locale),
            zh: t("header.langZh", locale),
            en: t("header.langEn", locale),
          }}
        />
      </div>
    </div>
  );
}
