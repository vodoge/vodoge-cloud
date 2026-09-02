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
    <div className="flex flex-1 flex-col items-center justify-center p-6">
      <div className="flex w-full max-w-measure flex-col gap-4 rounded-lg border border-border bg-surface p-8 shadow-lg">
        <div className="flex items-center gap-2 text-lg font-semibold text-foreground">
          <span
            className="flex size-6 shrink-0 items-center justify-center rounded bg-gradient-to-br from-brand to-brand-strong text-xs font-bold text-brand-ink"
            aria-hidden="true"
          >
            V
          </span>
          {t("app.name", locale)}
        </div>
        <div>
          <h1 className="m-0 text-xl font-semibold tracking-tight text-foreground">{t("login.title", locale)}</h1>
          <p className="m-0 mt-1 text-sm text-muted-foreground">{t("login.desc", locale)}</p>
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
        <p className="m-0 text-sm text-muted-foreground">{t("login.stub", locale)}</p>
      </div>
    </div>
  );
}
