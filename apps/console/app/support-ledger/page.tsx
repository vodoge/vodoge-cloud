import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CardEmpty, CardPanel as Card } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/form";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHead,
  TableRow,
} from "@/components/ui/table";
import { fetchConsoleRole, fetchLedger, type LedgerRow } from "@/lib/catalog";
import {
  alphabetical,
  biggestFirst,
  by,
  emptyKind,
  matches,
  needleOf,
  pickSort,
} from "@/lib/table-query";
import { mayWrite } from "@/lib/session";
import { t, type Locale } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";
import { requestHost, sessionToken } from "@/lib/tenant-headers";
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
const SORTS = ["modem", "carrier", "tested"] as const;

export default async function SupportLedgerPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; sort?: string }>;
}) {
  const query = await searchParams;
  const needle = needleOf(query.q);
  const order = pickSort(query.sort, SORTS, "modem");
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

  // 🔴 Ends on the family plus the carrier, which is what makes a row unique
  // here: two entries for the same module on different networks are different
  // rows, and without both the pair reshuffles between loads. `testedAt` is a
  // number on every row, so it needs no missing-last handling — but it goes
  // through the same comparator so the shape stays the one every other list
  // page uses.
  const shown = rows
    .filter((row) =>
      matches(needle, row.modemFamily, row.carrier, row.bearer, row.note, row.reason, row.testedBy),
    )
    .sort(
      by<LedgerRow>(
        (left, right) => (order === "tested" ? biggestFirst(left.testedAt, right.testedAt) : 0),
        (left, right) => (order === "carrier" ? alphabetical(left.carrier, right.carrier) : 0),
        (left, right) => alphabetical(left.modemFamily, right.modemFamily),
        (left, right) => alphabetical(left.carrier, right.carrier),
      ),
    );
  const empty = emptyKind(rows.length, shown.length, needle);

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start gap-4">
        <div>
          <h1 className="m-0 text-xl font-semibold tracking-tight text-foreground">{t("ledger.title", locale)}</h1>
          <p className="m-0 mt-1 text-sm text-muted-foreground">{t("ledger.desc", locale)}</p>
        </div>
      </div>
      {failed ? <p className="m-0 mb-4 text-sm text-destructive">{t("ledger.loadFailed", locale)}</p> : null}

      <Card title={t("ledger.measured", locale)} note={t("ledger.measuredNote", locale)}>
        {rows.length > 0 ? (
          <form className="mb-4 flex flex-col gap-4" method="get">
            <Field label={t("filter.search", locale)} inline>
              <Input name="q" defaultValue={needle} autoComplete="off" spellCheck={false} />
            </Field>
            <Field label={t("filter.sort", locale)} inline>
              <Select compact name="sort" defaultValue={order}>
                <option value="modem">{t("ledger.colModem", locale)}</option>
                <option value="carrier">{t("ledger.colCarrier", locale)}</option>
                <option value="tested">{t("ledger.sortTested", locale)}</option>
              </Select>
            </Field>
            <Button type="submit">{t("filter.apply", locale)}</Button>
          </form>
        ) : null}
        {empty === "noMatch" ? (
          <CardEmpty
            title={t("filter.noMatchTitle", locale)}
            description={t("filter.noMatchDesc", locale)}
          />
        ) : !failed && rows.length === 0 ? (
          <CardEmpty
            title={t("ledger.emptyTitle", locale)}
            description={t("ledger.emptyDesc", locale)}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow head>
                <TableHead>{t("ledger.colModem", locale)}</TableHead>
                <TableHead>{t("ledger.colCarrier", locale)}</TableHead>
                <TableHead>{t("ledger.colSmsMo", locale)}</TableHead>
                <TableHead>{t("ledger.colSmsMt", locale)}</TableHead>
                <TableHead secondary>{t("ledger.colData", locale)}</TableHead>
                <TableHead secondary>{t("ledger.colVoice", locale)}</TableHead>
                <TableHead secondary>{t("ledger.colEvidence", locale)}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((row) => (
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
    return <span className="text-muted-foreground">{t("ledger.unmeasured", locale)}</span>;
  }
  if (value === "supported") {
    return <Badge tone="ok">{t("ledger.supported", locale)}</Badge>;
  }
  if (value === "unsupported") {
    return <Badge tone="bad">{t("ledger.unsupported", locale)}</Badge>;
  }
  return <Badge tone="warn">{t("ledger.probe", locale)}</Badge>;
}
