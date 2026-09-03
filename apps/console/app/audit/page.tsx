import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardEmpty } from "@/components/ui/card";
import { Field, Input, Select } from "@/components/ui/form";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHead,
  TableRow,
} from "@/components/ui/table";
import { auditScreen, loadAudit } from "@/lib/catalog";
import { alphabetical, by, emptyKind, matches, needleOf, pickSort } from "@/lib/table-query";
import { t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";
import { requestHost, sessionToken } from "@/lib/tenant-headers";

/**
 * The first page moved onto Tailwind and the shared components.
 *
 * It was chosen for being the least interesting one: read-only, three columns,
 * no forms and no destructive controls, so what it demonstrates is the pattern
 * rather than a design.
 *
 * Every decision this page makes is made in `lib/catalog.ts`, including the
 * fetch failing. That is not tidiness: no `.tsx` in this app can be run by a
 * test — there is no jsdom, no testing-library, no vitest, no jest — so a
 * `try/catch` written here is a rule nothing can check. This page held one, and
 * what it could not say is how the page came to be wrong for as long as it was:
 * the gateway answered with events, the parser dropped all of them, nothing
 * threw, and "Nothing recorded yet" was drawn over a full audit log. `rows` and
 * `placeholder` are now mutually exclusive by construction, so a load that
 * failed and a tenant with no history cannot render as the same screen.
 *
 * 🔴 **The default order is the gateway's order, and that is not laziness.**
 * `AuditRow` is `{ actor, action, target }` — there is no timestamp on it, so
 * the order rows arrive in is the only recency signal this page has. Sorting
 * by actor as a default would silently shuffle a log and there would be
 * nothing left to recover the sequence from. Sorting is offered; it is not
 * imposed.
 *
 * `locale` is resolved on the server and used directly. It is deliberately not
 * read from a cookie in an effect: this console has shipped that bug twice,
 * and it renders the server's HTML in the default language every time while
 * looking correct in a browser, because hydration fixes it before anyone
 * looks.
 */
const SORTS = ["received", "actor", "action"] as const;

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; sort?: string }>;
}) {
  const query = await searchParams;
  const needle = needleOf(query.q);
  const order = pickSort(query.sort, SORTS, "received");
  const locale = await getRequestLocale();
  const host = await requestHost();
  const token = await sessionToken();
  const screen = auditScreen(await loadAudit(host, token));

  // The arrival index is carried through the sort so that every order stays
  // total and "received" is a real option rather than the absence of one.
  const shown = screen.rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => matches(needle, row.actor, row.action, row.target))
    .sort(
      by<{ row: (typeof screen.rows)[number]; index: number }>(
        (left, right) => (order === "actor" ? alphabetical(left.row.actor, right.row.actor) : 0),
        (left, right) => (order === "action" ? alphabetical(left.row.action, right.row.action) : 0),
        (left, right) => left.index - right.index,
      ),
    );
  const empty = emptyKind(screen.rows.length, shown.length, needle);

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start gap-4">
        <div>
          <h1 className="m-0 text-xl font-semibold tracking-tight text-foreground">{t("audit.title", locale)}</h1>
          <p className="m-0 mt-1 text-sm text-muted-foreground">{t("audit.desc", locale)}</p>
        </div>
      </div>
      {screen.errorKey ? (
        <p className="m-0 mb-4 text-sm text-destructive">{t(screen.errorKey, locale)}</p>
      ) : null}

      <Card>
        {/* Only drawn when there is a table to filter. A placeholder means the
            load failed or the tenant has no history, and offering a search box
            over neither would invite the reader to blame their filter. */}
        {screen.placeholder === null ? (
          <form className="mb-4 flex flex-col gap-4" method="get">
            <Field label={t("filter.search", locale)} inline>
              <Input name="q" defaultValue={needle} autoComplete="off" spellCheck={false} />
            </Field>
            <Field label={t("filter.sort", locale)} inline>
              <Select compact name="sort" defaultValue={order}>
                <option value="received">{t("audit.sortReceived", locale)}</option>
                <option value="actor">{t("audit.colActor", locale)}</option>
                <option value="action">{t("audit.colAction", locale)}</option>
              </Select>
            </Field>
            <Button type="submit">{t("filter.apply", locale)}</Button>
          </form>
        ) : null}
        {screen.placeholder ? (
          <CardEmpty
            title={t(screen.placeholder.titleKey, locale, screen.placeholder.vars)}
            description={t(
              screen.placeholder.descriptionKey,
              locale,
              screen.placeholder.vars,
            )}
          />
        ) : empty === "noMatch" ? (
          <CardEmpty
            title={t("filter.noMatchTitle", locale)}
            description={t("filter.noMatchDesc", locale)}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow head>
                <TableHead>{t("audit.colActor", locale)}</TableHead>
                <TableHead>{t("audit.colAction", locale)}</TableHead>
                <TableHead>{t("audit.colTarget", locale)}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map(({ row: event, index }) => (
                <TableRow key={`${event.action}:${index}`}>
                  <TableCell mono>{event.actor || "—"}</TableCell>
                  <TableCell>
                    {/* The action is a category, not a state, so no status dot:
                        a coloured dot here would imply a judgement the audit
                        log is not making. */}
                    <Badge dot={false}>{event.action}</Badge>
                  </TableCell>
                  <TableCell mono faint>
                    {event.target || "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </Card>
    </>
  );
}
