import { LocaleSwitch } from "@/components/locale-switch";
import { t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";

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
    <div className="flex flex-1 flex-col items-center justify-center p-6">
      <div className="flex w-full max-w-measure flex-col gap-4 rounded-lg border border-border bg-surface p-8 shadow-lg">
        <div>
          <h1 className="m-0 text-xl font-semibold tracking-tight text-foreground">{t("notFound.title", locale)}</h1>
          <p className="m-0 mt-1 text-sm text-muted-foreground">{t("notFound.body", locale)}</p>
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
