import { LoginForm } from "@/components/login-form";
import { t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";
import { safeNext } from "@/lib/session";
import { CENTERED, PAGE, SHELL } from "@/lib/tokens";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const locale = await getRequestLocale();
  const params = await searchParams;

  return (
    <div className={CENTERED.root}>
      <div className={CENTERED.card}>
        <div className={CENTERED.brand}>
          <span className={SHELL.brandMark} aria-hidden="true">
            V
          </span>
          {t("app.name", locale)}
        </div>
        <div>
          <h1 className={PAGE.title}>{t("login.title", locale)}</h1>
          <p className={PAGE.description}>{t("login.desc", locale)}</p>
        </div>
        <LoginForm
          next={safeNext(params.next)}
          labels={{
            email: t("login.username", locale),
            password: t("login.password", locale),
            submit: t("login.submit", locale),
            working: t("login.working", locale),
            error: t("login.error", locale),
            unavailable: t("login.unavailable", locale),
          }}
        />
        <p className={CENTERED.hint}>{t("login.stub", locale)}</p>
      </div>
    </div>
  );
}
