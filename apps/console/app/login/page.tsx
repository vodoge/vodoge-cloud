import Link from "next/link";
import { t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";

export default async function LoginPage() {
  const locale = await getRequestLocale();

  return (
    <section>
      <h1 className="page-title">{t("login.title", locale)}</h1>
      <p className="page-desc">{t("login.desc", locale)}</p>
      <form>
        <label>
          {t("login.username", locale)}
          <input name="username" autoComplete="username" disabled />
        </label>
        <label>
          {t("login.password", locale)}
          <input name="password" type="password" autoComplete="current-password" disabled />
        </label>
        <button type="submit" disabled>
          {t("login.submit", locale)}
        </button>
      </form>
      <p className="hint">{t("login.stub", locale)}</p>
      <p>
        <Link href="/">{t("login.backToDevices", locale)}</Link>
      </p>
    </section>
  );
}
