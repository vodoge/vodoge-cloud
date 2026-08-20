import { LocaleSwitch } from "@/components/locale-switch";
import { DEFAULT_BASE_DOMAIN, OPERATOR_SLUG } from "@/lib/host";
import { t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";

export default async function NotATenantPage() {
  const locale = await getRequestLocale();
  const domain = process.env.VODOGE_BASE_DOMAIN?.trim() || DEFAULT_BASE_DOMAIN;

  return (
    <div className="centered">
      <div className="centered-card">
        <h1 className="page-title">{t("apex.title", locale)}</h1>
        <p className="page-desc">
          {t("apex.body", locale, { slug: OPERATOR_SLUG, domain })}
        </p>
        <LocaleSwitch locale={locale} />
      </div>
    </div>
  );
}
