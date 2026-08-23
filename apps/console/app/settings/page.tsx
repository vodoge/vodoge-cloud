import { PasswordForm, SettingsForm, type Field } from "@/components/settings-form";
import { Card } from "@/components/ui";
import { fetchSettings, type SettingsBySection } from "@/lib/catalog";
import { t, type Locale } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";
import {
  bearerHeader,
  mayWrite,
  roleFromSessionBody,
  SESSION_ENDPOINT,
  type ConsoleRole,
} from "@/lib/session";
import { gatewayBaseUrl } from "@/lib/tenant";
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
  { path: "feishu.enabled", kind: "boolean" },
  { path: "feishu.webhook_url", kind: "text" },
  { path: "feishu.secret", kind: "secret" },
  { path: "wecom.enabled", kind: "boolean" },
  { path: "wecom.webhook_url", kind: "text" },
  { path: "pushplus.enabled", kind: "boolean" },
  { path: "pushplus.token", kind: "secret" },
  { path: "pushplus.topic", kind: "text" },
];

/**
 * The channels above, derived rather than listed a second time.
 *
 * Every one of them can be tested, because the gateway has a sender for every
 * one of them — `settings.NotificationChannels()` and `notify.Registry()` are
 * held equal by a test on that side. Writing the testable set out by hand is
 * how the last drift started: telegram had fields here and no sender there, so
 * configuring it did nothing at all and said nothing about it.
 */
const NOTIFICATION_CHANNELS = [
  ...new Set(NOTIFICATION_FIELDS.map((field) => field.path.split(".")[0]!)),
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
  const role = await currentRole(host, token);
  const writable = mayWrite(role);

  const labels = fieldLabels(locale);

  // Every field on this page saves through PUT /v1/settings/{section}, which
  // the gateway refuses outright for a read-only session. Rendering the forms
  // anyway would offer an operator a Save button whose only possible outcome
  // is a 403 — so the values are rendered instead of the inputs. Read-only is
  // not "cannot see"; hiding the section would take away the visibility the
  // account exists to have.
  function section(
    fields: Field[],
    values: Record<string, unknown>,
    name: "notifications" | "sms" | "security",
  ) {
    return writable ? (
      <SettingsForm
        section={name}
        initial={values}
        fields={fields}
        labels={labels}
        testable={name === "notifications" ? NOTIFICATION_CHANNELS : undefined}
      />
    ) : (
      <ReadOnlyFields fields={fields} values={values} labels={labels} />
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{t("settings.title", locale)}</h1>
          <p className="page-desc">{t("settings.desc", locale)}</p>
        </div>
        {writable ? null : <span className="badge badge-warn">{t("role.readOnlyBadge", locale)}</span>}
      </div>

      {loadError ? <p className="danger">{t("settings.loadError", locale)}</p> : null}
      {writable ? null : <p className="faint">{t("role.readOnlySettings", locale)}</p>}

      <div className="card-grid">
        <Card
          className="card-span-all"
          title={t("settings.notifications", locale)}
          note={t("settings.notificationsNote", locale)}
        >
          {section(NOTIFICATION_FIELDS, settings.notifications ?? {}, "notifications")}
        </Card>

        <Card title={t("settings.sms", locale)} note={t("settings.smsNote", locale)}>
          {section(SMS_FIELDS, settings.sms ?? {}, "sms")}
        </Card>

        <Card title={t("settings.security", locale)} note={t("settings.securityNote", locale)}>
          {section(SECURITY_FIELDS, settings.security ?? {}, "security")}
        </Card>

        {/* Not gated. Rotating your own password is not a tenant write, the
            gateway lets a read-only session do it, and an account that cannot
            respond to its own credential leaking is worse off with nobody
            safer. */}
        <Card title={t("settings.account", locale)} note={t("settings.accountNote", locale)}>
          <PasswordForm labels={labels} />
        </Card>
      </div>
    </>
  );
}

/**
 * The role for this request, from the gateway.
 *
 * Failing closed. If the gateway cannot be asked, the page draws its read-only
 * form: the account may lose a Save button it was entitled to, which is
 * recoverable by reloading, and the gateway is the thing that actually decides.
 */
async function currentRole(host: string, token: string | undefined): Promise<ConsoleRole> {
  try {
    const response = await fetch(`${gatewayBaseUrl()}${SESSION_ENDPOINT}`, {
      headers: {
        accept: "application/json",
        "x-forwarded-host": host,
        ...bearerHeader(token),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return "readonly";
    return roleFromSessionBody(await response.json());
  } catch {
    return "readonly";
  }
}

/** The same fields a form would render, as values. */
function ReadOnlyFields({
  fields,
  values,
  labels,
}: {
  fields: Field[];
  values: Record<string, unknown>;
  labels: Record<string, string>;
}) {
  return (
    <div className="table-wrap">
      <table>
        <tbody>
          {fields.map((field) => (
            <tr key={field.path}>
              <td>{labels[field.path] ?? field.path}</td>
              <td className="mono">{display(read(values, field.path))}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A stored value at a dotted path, the same way the form reads it. */
function read(source: Record<string, unknown>, path: string): unknown {
  let cursor: unknown = source;
  for (const key of path.split(".")) {
    if (!cursor || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

function display(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  if (Array.isArray(value)) return value.length === 0 ? "—" : value.join(", ");
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
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
