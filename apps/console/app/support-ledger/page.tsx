import { Badge } from "@/components/ui/badge";
import { CardEmpty, CardPanel as Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@/components/ui/table";
import { fetchConsoleRole, fetchLedger, type LedgerRow } from "@/lib/catalog";
import { mayWrite } from "@/lib/session";
import { t, type Locale } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";
import { requestHost, sessionToken } from "@/lib/tenant-headers";
import { PAGE, TABLE } from "@/lib/tokens";
import { LedgerAdmin } from "@/components/support-ledger";

/**
 * What has been measured, on which module, on whose network.
 *
 * This page is the iron rule made visible: a pairing that is not a row here is
 * refused by the edge as untested, and the refusal says so by name. So the
 * absence of a row is as much a record as its presence, and the empty state
 * says that rather than apologising for having nothing to show.
 *
 * The evidence columns are not decoration. `testedBy` and `testedAt` are what
 * separate a measurement from an opinion, and they are the first thing anybody
 * asks when a stick refuses something they thought worked.
 *
 * Recording and publishing are two screens' worth of the same page on purpose:
 * saving a row changes nothing about what the fleet will attempt, and only
 * publishing does. A half-finished afternoon of testing should not reach
 * hardware because somebody saved a form.
 */
export default async function SupportLedgerPage() {
  const locale = await getRequestLocale();
  const host = await requestHost();
  const token = await sessionToken();
  const writable = mayWrite(await fetchConsoleRole(host, token));

  let rows: LedgerRow[] = [];
  let failed = false;
  try {
    rows = await fetchLedger(host, token);
  } catch {
    // Same reasoning as the audit page: a load that failed and a tenant that
    // has measured nothing must not render as the same screen. Here it matters
    // more, because "nothing measured" is a claim about the fleet's behaviour.
    failed = true;
  }

  return (
    <>
      <div className={PAGE.head}>
        <div>
          <h1 className={PAGE.title}>{t("ledger.title", locale)}</h1>
          <p className={PAGE.description}>{t("ledger.desc", locale)}</p>
        </div>
      </div>
      {failed ? <p className={PAGE.error}>{t("ledger.loadFailed", locale)}</p> : null}

      <Card title={t("ledger.measured", locale)} note={t("ledger.measuredNote", locale)}>
        {!failed && rows.length === 0 ? (
          <CardEmpty
            title={t("ledger.emptyTitle", locale)}
            description={t("ledger.emptyDesc", locale)}
          />
        ) : (
          <Table>
            <TableHead>
              <TableRow head>
                <TableHeaderCell>{t("ledger.colModem", locale)}</TableHeaderCell>
                <TableHeaderCell>{t("ledger.colCarrier", locale)}</TableHeaderCell>
                <TableHeaderCell>{t("ledger.colSmsMo", locale)}</TableHeaderCell>
                <TableHeaderCell>{t("ledger.colSmsMt", locale)}</TableHeaderCell>
                <TableHeaderCell secondary>{t("ledger.colData", locale)}</TableHeaderCell>
                <TableHeaderCell secondary>{t("ledger.colVoice", locale)}</TableHeaderCell>
                <TableHeaderCell secondary>{t("ledger.colEvidence", locale)}</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={`${row.modemFamily}:${row.carrier}`}>
                  <TableCell mono>{row.modemFamily}</TableCell>
                  <TableCell mono>{row.carrier}</TableCell>
                  <TableCell>
                    <Support value={row.smsMo} locale={locale} />
                  </TableCell>
                  <TableCell>
                    <Support value={row.smsMt} locale={locale} />
                  </TableCell>
                  <TableCell secondary>
                    <Support value={row.data} locale={locale} />
                  </TableCell>
                  <TableCell secondary>
                    <Support value={row.voice} locale={locale} />
                  </TableCell>
                  <TableCell faint secondary title={row.note || undefined}>
                    {row.testedBy}
                    {row.testedAt > 0
                      ? ` · ${new Date(row.testedAt).toISOString().slice(0, 10)}`
                      : ""}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>

      <LedgerAdmin
        writable={writable}
        rowCount={rows.length}
        labels={{
          record: t("ledger.record", locale),
          recordNote: t("ledger.recordNote", locale),
          modem: t("ledger.colModem", locale),
          carrier: t("ledger.colCarrier", locale),
          smsMo: t("ledger.colSmsMo", locale),
          smsMt: t("ledger.colSmsMt", locale),
          data: t("ledger.colData", locale),
          voice: t("ledger.colVoice", locale),
          testedBy: t("ledger.testedBy", locale),
          note: t("ledger.note", locale),
          save: t("ledger.save", locale),
          publish: t("ledger.publish", locale),
          publishNote: t("ledger.publishNote", locale),
          failed: t("ledger.failed", locale),
          unmeasured: t("ledger.unmeasured", locale),
          supported: t("ledger.supported", locale),
          unsupported: t("ledger.unsupported", locale),
          probe: t("ledger.probe", locale),
          confirmPublishTitle: t("ledger.confirmPublishTitle", locale),
          confirmPublish: t("ledger.confirmPublish", locale),
          question: t("confirm.question", locale),
          proceed: t("confirm.proceed", locale),
          cancel: t("confirm.cancel", locale),
        }}
      />
    </>
  );
}

/**
 * One measured verdict.
 *
 * `null` is not "no": it is an operation this measurement did not cover, which
 * the edge treats as untested. Rendering both as the same dash is how a
 * half-measurement comes to look complete.
 */
function Support({ value, locale }: { value: string | null; locale: Locale }) {
  if (value === null) {
    return <span className={TABLE.cellFaint}>{t("ledger.unmeasured", locale)}</span>;
  }
  if (value === "supported") {
    return <Badge tone="ok">{t("ledger.supported", locale)}</Badge>;
  }
  if (value === "unsupported") {
    return <Badge tone="bad">{t("ledger.unsupported", locale)}</Badge>;
  }
  return <Badge tone="warn">{t("ledger.probe", locale)}</Badge>;
}
