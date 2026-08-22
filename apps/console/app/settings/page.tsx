import { PasswordForm, SettingsForm, type Field } from "@/components/settings-form";
import { Card } from "@/components/ui";
import { fetchSettings, type SettingsBySection } from "@/lib/catalog";
import { t, type Locale } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";
import { requestHost, sessionToken } from "@/lib/tenant-headers";

/**
 * The old product's settings were machine-global: one box, one owner, one set
 * of channels. Here every one of them belongs to a tenant.
 *
 * Two of the old sections are deliberately absent. HTTPS and its certificate
 * are terminated at the gateway for every tenant at once, so they are not a
 * tenant's to configure; and device defaults have no fields yet, so rendering
 * an empty card would only raise a question the page cannot answer.
 */
const NOTIFICATION_FIELDS: Field[] = [
  { path: "webhook.enabled", kind: "boolean" },
  { path: "webhook.urls", kind: "list" },
  { path: "webhook.secret", kind: "secret" },
  { path: "email.enabled", kind: "boolean" },
  { path: "email.smtp_host", kind: "text" },
  { path: "email.smtp_port", kind: "number" },
  { path: "email.username", kind: "text" },
  { path: "email.password", kind: "secret" },
  { path: "email.from_address", kind: "text" },
  { path: "email.to_addresses", kind: "list" },
  { path: "bark.enabled", kind: "boolean" },
  { path: "bark.urls", kind: "list" },
  { path: "telegram.enabled", kind: "boolean" },
  { path: "telegram.chat_id", kind: "text" },
  { path: "telegram.bot_token", kind: "secret" },
];

const SMS_FIELDS: Field[] = [{ path: "hourly_limit", kind: "number" }];
const SECURITY_FIELDS: Field[] = [{ path: "session_ttl_hours", kind: "number" }];

export default async function SettingsPage() {
  const locale = await getRequestLocale();
  const host = await requestHost();
  const token = await sessionToken();

  let settings: SettingsBySection = {};
  let loadError = false;
  try {
    settings = await fetchSettings(host, token);
  } catch {
    loadError = true;
  }

  const labels = fieldLabels(locale);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t("settings.title", locale)}</h1>
          <p className="page-desc">{t("settings.desc", locale)}</p>
        </div>
      </div>

      {loadError ? <p className="danger">{t("settings.loadError", locale)}</p> : null}

      <div className="card-grid">
        <Card
          className="card-span-all"
          title={t("settings.notifications", locale)}
          note={t("settings.notificationsNote", locale)}
        >
          <SettingsForm
            section="notifications"
            initial={settings.notifications ?? {}}
            fields={NOTIFICATION_FIELDS}
            labels={labels}
            // Only the channels the gateway can actually deliver through.
            // Offering a test for one it cannot send is a button that can
            // only fail.
            testable={["webhook", "bark", "email"]}
          />
        </Card>

        <Card title={t("settings.sms", locale)} note={t("settings.smsNote", locale)}>
          <SettingsForm
            section="sms"
            initial={settings.sms ?? {}}
            fields={SMS_FIELDS}
            labels={labels}
          />
        </Card>

        <Card title={t("settings.security", locale)} note={t("settings.securityNote", locale)}>
          <SettingsForm
            section="security"
            initial={settings.security ?? {}}
            fields={SECURITY_FIELDS}
            labels={labels}
          />
        </Card>

        <Card title={t("settings.account", locale)} note={t("settings.accountNote", locale)}>
          <PasswordForm labels={labels} />
        </Card>
      </div>
    </>
  );
}

/**
 * Field labels are looked up by the same dotted path the form posts, so a
 * field added to the list above needs one translation key and nothing else.
 */
function fieldLabels(locale: Locale): Record<string, string> {
  const paths = [...NOTIFICATION_FIELDS, ...SMS_FIELDS, ...SECURITY_FIELDS].map(
    (field) => field.path,
  );
  const labels: Record<string, string> = {
    save: t("settings.save", locale),
    saved: t("settings.saved", locale),
    saveFailed: t("settings.saveFailed", locale),
    currentPassword: t("settings.currentPassword", locale),
    newPassword: t("settings.newPassword", locale),
    changePassword: t("settings.changePassword", locale),
    passwordChanged: t("settings.passwordChanged", locale),
    passwordNote: t("settings.passwordNote", locale),
    test: t("settings.test", locale),
    testSent: t("settings.testSent", locale),
    testFailed: t("settings.testFailed", locale),
  };
  for (const path of paths) {
    labels[path] = t(`f.${path}`, locale);
  }
  return labels;
}
