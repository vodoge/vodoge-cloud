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
import { fetchAudit, type AuditRow } from "@/lib/catalog";
import { t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";
import { requestHost, sessionToken } from "@/lib/tenant-headers";
import { PAGE } from "@/lib/tokens";

/**
 * The first page moved onto Tailwind and the shared components.
 *
 * It was chosen for being the least interesting one: read-only, three columns,
 * no forms and no destructive controls, so what it demonstrates is the pattern
 * rather than a design. The fetch, the error handling and the empty case are
 * unchanged from the hand-styled version — this card changes how the page
 * looks, not what it does.
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
  let events: AuditRow[] = [];
  let loadError = false;
  try {
    events = await fetchAudit(host, token);
  } catch {
    loadError = true;
  }

  return (
    <>
      <div className={PAGE.head}>
        <div>
          <h1 className={PAGE.title}>{t("audit.title", locale)}</h1>
          <p className={PAGE.description}>{t("audit.desc", locale)}</p>
        </div>
      </div>
      {loadError ? <p className={PAGE.error}>{t("audit.loadError", locale)}</p> : null}

      <Card>
        {events.length === 0 ? (
          <CardEmpty
            title={t("empty.audit.title", locale)}
            description={t("empty.audit.desc", locale)}
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
              {events.map((event, index) => (
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
