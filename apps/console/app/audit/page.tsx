import { Badge } from "@/components/ui/badge";
import { Card, CardEmpty } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@/components/ui/table";
import { auditScreen, loadAudit } from "@/lib/catalog";
import { t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";
import { requestHost, sessionToken } from "@/lib/tenant-headers";
import { PAGE } from "@/lib/tokens";

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
 * `locale` is resolved on the server and used directly. It is deliberately not
 * read from a cookie in an effect: this console has shipped that bug twice,
 * and it renders the server's HTML in the default language every time while
 * looking correct in a browser, because hydration fixes it before anyone
 * looks.
 */
export default async function AuditPage() {
  const locale = await getRequestLocale();
  const host = await requestHost();
  const token = await sessionToken();
  const screen = auditScreen(await loadAudit(host, token));

  return (
    <>
      <div className={PAGE.head}>
        <div>
          <h1 className={PAGE.title}>{t("audit.title", locale)}</h1>
          <p className={PAGE.description}>{t("audit.desc", locale)}</p>
        </div>
      </div>
      {screen.errorKey ? (
        <p className={PAGE.error}>{t(screen.errorKey, locale)}</p>
      ) : null}

      <Card>
        {screen.placeholder ? (
          <CardEmpty
            title={t(screen.placeholder.titleKey, locale, screen.placeholder.vars)}
            description={t(
              screen.placeholder.descriptionKey,
              locale,
              screen.placeholder.vars,
            )}
          />
        ) : (
          <Table>
            <TableHead>
              <TableRow head>
                <TableHeaderCell>{t("audit.colActor", locale)}</TableHeaderCell>
                <TableHeaderCell>{t("audit.colAction", locale)}</TableHeaderCell>
                <TableHeaderCell>{t("audit.colTarget", locale)}</TableHeaderCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {screen.rows.map((event, index) => (
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
