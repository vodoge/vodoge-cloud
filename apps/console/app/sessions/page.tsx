import { LiveReload } from "@/components/live-reload";
import { Card, CardEmpty } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHead,
  TableRow,
} from "@/components/ui/table";
import { fetchSessions, type SessionRow } from "@/lib/catalog";
import { requestHost, sessionToken } from "@/lib/tenant-headers";
import { t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";
import { PAGE } from "@/lib/tokens";

/**
 * Threads, one row per peer.
 *
 * Moved onto the design system. The fetch, the failure case, the empty case
 * and the ordering are untouched: this page has no controls and writes
 * nothing, so there was nothing to change but the way it looks.
 *
 * The message body is the one column here with no width limit — an SMS can be
 * a paragraph of Chinese or a 120-character activation URL — so it carries
 * `wrap`. `count` is `secondary` and leaves the phone: how many messages a
 * thread holds is context, while who sent what and when is the question the
 * row is being read for.
 *
 * `locale` is resolved on the server and used directly, never read from a
 * cookie in an effect. This console has shipped that bug twice; it renders the
 * server's HTML in the default language every time while looking correct in a
 * browser, because hydration fixes it before anyone looks.
 */
export default async function SessionsPage() {
  const locale = await getRequestLocale();
  const host = await requestHost();
  const token = await sessionToken();
  let sessions: SessionRow[] = [];
  let loadError = false;
  try {
    sessions = await fetchSessions(host, token);
  } catch {
    loadError = true;
  }

  return (
    <>
      <LiveReload />
      <div className={PAGE.head}>
        <div>
          <h1 className={PAGE.title}>{t("sessions.title", locale)}</h1>
          <p className={PAGE.description}>{t("sessions.desc", locale)}</p>
        </div>
      </div>
      {loadError ? <p className={PAGE.error}>{t("sessions.loadError", locale)}</p> : null}

      <Card>
        {sessions.length === 0 ? (
          <CardEmpty
            title={t("empty.sessions.title", locale)}
            description={t("empty.sessions.desc", locale)}
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow head>
                <TableHead>{t("sessions.colPeer", locale)}</TableHead>
                <TableHead secondary>{t("sessions.colCount", locale)}</TableHead>
                <TableHead>{t("sessions.colLastBody", locale)}</TableHead>
                <TableHead>{t("sessions.colLastReceived", locale)}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((row) => (
                <TableRow key={`${row.deviceId}:${row.peer}`}>
                  <TableCell mono>{row.peer}</TableCell>
                  <TableCell mono secondary>
                    {row.count}
                  </TableCell>
                  <TableCell wrap>{row.lastBody}</TableCell>
                  <TableCell mono faint>
                    {new Date(row.lastReceivedAt).toISOString().replace("T", " ").slice(0, 19)}
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
