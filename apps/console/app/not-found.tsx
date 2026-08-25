import { LocaleSwitch } from "@/components/locale-switch";
import { t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";
import { CENTERED, PAGE } from "@/lib/tokens";

/**
 * Reached for an unknown subdomain, which the middleware rewrites here rather
 * than falling back to a tenant.
 *
 * The old markup asked for `.centered` and `.centered-card`. Neither class has
 * ever existed in `globals.css`, so this page has been rendering as unstyled
 * top-left text — the same defect T021 found on `send-sms.tsx`. It is a card
 * in the middle of the viewport now, like the login page it sits next to.
 */
export default async function NotFound() {
  const locale = await getRequestLocale();

  return (
    <div className={CENTERED.root}>
      <div className={CENTERED.card}>
        <div>
          <h1 className={PAGE.title}>{t("notFound.title", locale)}</h1>
          <p className={PAGE.description}>{t("notFound.body", locale)}</p>
        </div>
        <LocaleSwitch locale={locale} />
      </div>
    </div>
  );
}
