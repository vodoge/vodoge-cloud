import { LocaleSwitch } from "@/components/locale-switch";
import { DEFAULT_BASE_DOMAIN, OPERATOR_SLUG } from "@/lib/host";
import { t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";
import { CENTERED, PAGE } from "@/lib/tokens";

/** What the parent domain serves. Same shape as `not-found.tsx`; see its note
 *  about `.centered`, which has never existed in the stylesheet. */
export default async function NotATenantPage() {
  const locale = await getRequestLocale();
  const domain = process.env.VODOGE_BASE_DOMAIN?.trim() || DEFAULT_BASE_DOMAIN;

  return (
    <div className={CENTERED.root}>
      <div className={CENTERED.card}>
        <div>
          <h1 className={PAGE.title}>{t("apex.title", locale)}</h1>
          <p className={PAGE.description}>
            {t("apex.body", locale, { slug: OPERATOR_SLUG, domain })}
          </p>
        </div>
        <LocaleSwitch locale={locale} />
      </div>
    </div>
  );
}
