import { LocaleSwitch } from "@/components/locale-switch";
import { t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";

export default async function NotFound() {
  const locale = await getRequestLocale();

  return (
    <div className="centered">
      <div className="centered-card">
        <h1 className="page-title">{t("notFound.title", locale)}</h1>
        <p className="page-desc">{t("notFound.body", locale)}</p>
        <LocaleSwitch locale={locale} />
      </div>
    </div>
  );
}
