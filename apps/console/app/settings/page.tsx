import { PasswordForm, SettingsForm, type ChannelTest } from "@/components/settings-form";
import { Badge } from "@/components/ui/badge";
import { CardDisclosure, CardPanel as Card } from "@/components/ui/card";
import { SpecRow, SpecTable, TableBody } from "@/components/ui/table";
import { fetchSettings, type SettingsBySection } from "@/lib/catalog";
import { MISSING_KEY_PATTERN, t, type Locale } from "@/lib/i18n";
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
import {
  NOTIFICATION_FIELDS,
  DEVICE_FIELDS,
  SECURITY_FIELDS,
  SMS_FIELDS,
  displaySettingValue,
  groupSettingsFields,
  notificationChannels,
  readSettingValue,
  settingsGroupIsOn,
  settingsSaveConsequence,
  type SettingsField,
  type SettingsGroup,
} from "@/lib/tokens";

/**
 * The old product's settings were machine-global: one box, one owner, one set
 * of channels. Here every one of them belongs to a tenant.
 *
 * The field tables moved to `lib/tokens.ts`, where a test can read them: this
 * page's real content is a list of dotted paths and their types, and a `.tsx`
 * cannot be read by a test in this app. What is left here is the page — which
 * cards there are, who may write, and which strings the forms are handed.
 *
 * `locale` is resolved on the server and passed down. It is deliberately not
 * read from a cookie in an effect: this console has shipped that bug twice, and
 * it renders the server's HTML in the default language every time while looking
 * correct in a browser, because hydration fixes it before anyone looks.
 */
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
  const confirm = {
    question: t("confirm.question", locale),
    proceed: t("confirm.proceed", locale),
    cancel: t("confirm.cancel", locale),
  };

  // Every field on this page saves through PUT /v1/settings/{section}, which
  // the gateway refuses outright for a read-only session. Rendering the forms
  // anyway would offer an operator a Save button whose only possible outcome
  // is a 403 — so the values are rendered instead of the inputs. Read-only is
  // not "cannot see"; hiding the section would take away the visibility the
  // account exists to have.
  function section(
    fields: readonly SettingsField[],
    values: Record<string, unknown>,
    name: "notifications" | "sms" | "security" | "devices",
    title: string,
  ) {
    return writable ? (
      <SettingsForm
        section={name}
        initial={values}
        fields={fields}
        labels={labels}
        confirm={confirm}
        saveTitle={t("settings.confirmSaveTitle", locale, { section: title })}
        saveConsequence={settingsSaveConsequence(fields, {
          save: t("settings.confirmSave", locale, { section: title }),
          secrets: t("settings.confirmSaveSecrets", locale),
        })}
        testable={name === "notifications" ? channelTests(fields, labels, locale) : undefined}
      />
    ) : (
      <ReadOnlyFields fields={fields} values={values} labels={labels} />
    );
  }

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start gap-4">
        <div>
          <h1 className="m-0 text-xl font-semibold tracking-tight text-foreground">{t("settings.title", locale)}</h1>
          <p className="m-0 mt-1 text-sm text-muted-foreground">{t("settings.desc", locale)}</p>
        </div>
        {writable ? null : (
          <Badge tone="warn" dot={false}>
            {t("role.readOnlyBadge", locale)}
          </Badge>
        )}
      </div>

      {loadError ? <p className="m-0 mb-4 text-sm text-destructive">{t("settings.loadError", locale)}</p> : null}
      {writable ? null : <p className="m-0 mt-1 text-sm text-muted-foreground">{t("role.readOnlySettings", locale)}</p>}

      {/* `"flex flex-col gap-6"`, not the `card-grid` this page asked for from the day it
          was written. That class is in no stylesheet and never has been, so
          these four cards have been sitting in ordinary block flow with no gap
          at all between them, on a page whose markup says it lays them out in a
          grid. It was found by a check, not by three separate surveys. */}
      <div className="flex flex-col gap-6">
        <Card
          title={t("settings.notifications", locale)}
          note={t("settings.notificationsNote", locale)}
        >
          {section(
            NOTIFICATION_FIELDS,
            settings.notifications ?? {},
            "notifications",
            t("settings.notifications", locale),
          )}
        </Card>

        <Card title={t("settings.sms", locale)} note={t("settings.smsNote", locale)}>
          {section(SMS_FIELDS, settings.sms ?? {}, "sms", t("settings.sms", locale))}
        </Card>

        <Card title={t("settings.devices", locale)} note={t("settings.devicesNote", locale)}>
          {section(DEVICE_FIELDS, settings.devices ?? {}, "devices", t("settings.devices", locale))}
        </Card>

        <Card title={t("settings.security", locale)} note={t("settings.securityNote", locale)}>
          {section(
            SECURITY_FIELDS,
            settings.security ?? {},
            "security",
            t("settings.security", locale),
          )}
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

/**
 * One confirmation per channel, written on the server.
 *
 * Derived from the fields, so there is no list of channels here to fall behind
 * the one the gateway has senders for — which is the drift that once left
 * telegram configurable and unable to send. The text is interpolated here
 * rather than in the form because `lib/i18n.ts` imports both catalogues, and
 * importing it from a client component would ship every string in this console
 * to the browser twice over.
 */
function channelTests(
  fields: readonly SettingsField[],
  labels: Record<string, string>,
  locale: Locale,
): ChannelTest[] {
  return notificationChannels(fields).map((channel) => {
    const label = labels[channel] ?? channel;
    return {
      channel,
      label,
      title: t("settings.confirmTestTitle", locale, { channel: label }),
      consequence: t("settings.confirmTest", locale, { channel: label }),
    };
  });
}

/**
 * The same fields a form would render, as values.
 *
 * A `SpecTable`, not the data grid: this is a list of a name and a reading, and
 * it has no `<th>` row at all — one of the five tables in this console that
 * have none, which is why any narrow-screen treatment built on header text
 * would have done nothing here. It folds by channel exactly as the editable
 * form does, so a read-only account reads the same page shape.
 */
function ReadOnlyFields({
  fields,
  values,
  labels,
}: {
  fields: readonly SettingsField[];
  values: Record<string, unknown>;
  labels: Record<string, string>;
}) {
  const stored = Object.fromEntries(
    fields.map((field) => [field.path, readSettingValue(values, field.path)]),
  );
  const words = { on: labels.valueOn as string, off: labels.valueOff as string };

  return (
    <div className="flex flex-col gap-3">
      {groupSettingsFields(fields).map((group) =>
        group.name === null ? (
          <SpecTable key="flat">
            <TableBody>{rows(group, values, labels, words)}</TableBody>
          </SpecTable>
        ) : (
          <CardDisclosure
            key={group.name}
            open={settingsGroupIsOn(group, stored)}
            title={labels[group.name] ?? group.name}
            hint={
              group.enabledPath === null ? undefined : (
                <Badge tone={settingsGroupIsOn(group, stored) ? "ok" : "neutral"}>
                  {settingsGroupIsOn(group, stored) ? labels.channelOn : labels.channelOff}
                </Badge>
              )
            }
          >
            <SpecTable>
              <TableBody>{rows(group, values, labels, words)}</TableBody>
            </SpecTable>
          </CardDisclosure>
        ),
      )}
    </div>
  );
}

function rows(
  group: SettingsGroup,
  values: Record<string, unknown>,
  labels: Record<string, string>,
  words: { on: string; off: string },
) {
  return group.fields.map((field) => (
    <SpecRow key={field.path} term={labels[field.path] ?? field.path} mono>
      {displaySettingValue(readSettingValue(values, field.path), words)}
    </SpecRow>
  ));
}

/**
 * Field labels are looked up by the same dotted path the form posts, so a field
 * added to `NOTIFICATION_FIELDS` needs one translation key and nothing else.
 *
 * A channel's own name is `f.<channel>` — the prefix its fields share. A
 * channel added without one falls back to the prefix itself rather than
 * rendering ⟦f.whatever⟧ in a panel heading; `tokens.test.ts` asserts every
 * channel this console actually ships has a name in both catalogues, so the
 * fallback is for the next one rather than for these.
 */
function fieldLabels(locale: Locale): Record<string, string> {
  const fields = [...NOTIFICATION_FIELDS, ...SMS_FIELDS, ...SECURITY_FIELDS, ...DEVICE_FIELDS];
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
    listHint: t("settings.listHint", locale),
    channelOn: t("settings.channelOn", locale),
    channelOff: t("settings.channelOff", locale),
    valueOn: t("settings.valueOn", locale),
    valueOff: t("settings.valueOff", locale),
  };
  for (const field of fields) {
    labels[field.path] = t(`f.${field.path}`, locale);
  }
  for (const channel of notificationChannels(NOTIFICATION_FIELDS)) {
    const name = t(`f.${channel}`, locale);
    labels[channel] = MISSING_KEY_PATTERN.test(name) ? channel : name;
  }
  return labels;
}
