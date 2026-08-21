import { LoginForm } from "@/components/login-form";
import { t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";
import { safeNext } from "@/lib/session";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const locale = await getRequestLocale();
  const params = await searchParams;

  return (
    <section>
      <h1 className="page-title">{t("login.title", locale)}</h1>
      <p className="page-desc">{t("login.desc", locale)}</p>
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
      <p className="hint">{t("login.stub", locale)}</p>
    </section>
  );
}
