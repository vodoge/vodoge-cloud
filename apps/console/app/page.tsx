import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardActions,
  CardEmpty,
  CardHeader,
  CardNote,
  CardTitle,
  StatCard,
  StatRow,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHead,
  TableRow,
} from "@/components/ui/table";
import { fetchDevices, fetchMessages, fetchSessions, type DeviceRow } from "@/lib/catalog";
import { t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";
import { requestHost, sessionToken } from "@/lib/tenant-headers";
import { PAGE, buttonClass } from "@/lib/tokens";

/**
 * The landing page answers "is anything wrong, and what just happened".
 *
 * It leads with a few numbers that prove the fleet is working, then one list of
 * recent activity. Everything else is a click away: a home that renders every
 * table is one nobody reads.
 *
 * Moved onto the design system. The three fetches, the failure case, the empty
 * case, the sort, the eight-row cut and the one link out are unchanged — this
 * page has no controls and writes nothing, so there was nothing here to change
 * but the way it looks.
 *
 * `locale` is resolved on the server and used directly, never read from a
 * cookie in an effect. This console has shipped that bug twice; it renders the
 * server's HTML in the default language every time while looking correct in a
 * browser, because hydration fixes it before anyone looks.
 */
export default async function OverviewPage() {
  const locale = await getRequestLocale();
  const host = await requestHost();
  const token = await sessionToken();

  let devices: DeviceRow[] = [];
  let messages: Awaited<ReturnType<typeof fetchMessages>> = [];
  let peers = 0;
  let loadError = false;
  try {
    [devices, messages, peers] = await Promise.all([
      fetchDevices(host, token),
      fetchMessages(host, token),
      fetchSessions(host, token).then((rows) => rows.length),
    ]);
  } catch {
    loadError = true;
  }

  const online = devices.filter((device) => device.state === "online").length;
  const recent = [...messages]
    .sort((left, right) => right.receivedAt - left.receivedAt)
    .slice(0, 8);

  return (
    <>
      <div className={PAGE.head}>
        <div>
          <h1 className={PAGE.title}>{t("overview.title", locale)}</h1>
          <p className={PAGE.description}>{t("overview.desc", locale)}</p>
        </div>
      </div>

      {loadError ? <p className={PAGE.error}>{t("inbox.loadError", locale)}</p> : null}

      <div className={PAGE.stack}>
        <StatRow>
          {/* The only number here that is a judgement: some of the fleet being
              offline is a thing to act on, whereas a message count is not. An
              empty fleet gets no tone at all — "0 of 0" is not a fault. */}
          <StatCard
            label={t("overview.devices", locale)}
            value={online}
            hint={t("overview.devicesHint", locale, { total: devices.length })}
            tone={devices.length === 0 ? undefined : online === devices.length ? "ok" : "warn"}
          />
          <StatCard
            label={t("overview.messages", locale)}
            value={messages.length}
            hint={t("overview.messagesHint", locale)}
          />
          <StatCard
            label={t("overview.peers", locale)}
            value={peers}
            hint={t("overview.peersHint", locale)}
          />
        </StatRow>

        <Card>
          <CardHeader>
            <CardTitle>{t("overview.recent", locale)}</CardTitle>
            <CardNote>{t("overview.recentNote", locale)}</CardNote>
            <CardActions>
              <Link className={buttonClass({ variant: "ghost" })} href="/inbox">
                {t("overview.seeAll", locale)}
              </Link>
            </CardActions>
          </CardHeader>

          {recent.length === 0 ? (
            <CardEmpty
              title={t("empty.messages.title", locale)}
              description={t("empty.messages.desc", locale)}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow head>
                  <TableHead>{t("inbox.colPeer", locale)}</TableHead>
                  <TableHead>{t("inbox.colBody", locale)}</TableHead>
                  <TableHead>{t("inbox.colBearer", locale)}</TableHead>
                  <TableHead>{t("inbox.colReceived", locale)}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recent.map((message) => (
                  <TableRow key={message.id}>
                    <TableCell mono>{message.peer}</TableCell>
                    <TableCell>{message.body}</TableCell>
                    <TableCell>
                      {/* The bearer is which transport carried the message —
                          a category, not a state, so it keeps the tone the
                          hand-written pill had and drops the status dot.
                          `StateBadge` would run the word through
                          `toneForState`, which does not know "sms" or "ims"
                          and would correctly answer "neutral" — turning a
                          deliberate colour into a silent loss of one. */}
                      <Badge tone="info" dot={false}>
                        {message.bearer}
                      </Badge>
                    </TableCell>
                    <TableCell mono faint>
                      {new Date(message.receivedAt).toISOString().replace("T", " ").slice(0, 19)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
