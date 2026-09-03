import { LiveReload } from "@/components/live-reload";
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
import { fetchSessions, type SessionRow } from "@/lib/catalog";
import {
  alphabetical,
  biggestFirst,
  by,
  emptyKind,
  matches,
  needleOf,
  pickSort,
} from "@/lib/table-query";
import { requestHost, sessionToken } from "@/lib/tenant-headers";
import { t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";

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
 * The filter and the ordering are in the URL, the way `app/devices/page.tsx`
 * does it: the work stays on the server, a filtered view is a link somebody
 * can send, and the page keeps working with no JavaScript at all. The
 * deciding parts — which sort values are accepted, where a row with no
 * reading goes, whether the order is total — are in `lib/table-query.ts`
 * because a `.tsx` in this app cannot be tested.
 *
 * `locale` is resolved on the server and used directly, never read from a
 * cookie in an effect. This console has shipped that bug twice; it renders the
 * server's HTML in the default language every time while looking correct in a
 * browser, because hydration fixes it before anyone looks.
 */
const SORTS = ["received", "count", "peer"] as const;

export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; sort?: string }>;
}) {
  const query = await searchParams;
  const needle = needleOf(query.q);
  // Newest thread first is what this page is read for, so it is the default.
  const order = pickSort(query.sort, SORTS, "received");
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

  // 🔴 Every branch falls through to the peer, which is unique per device on
  // this list. Without that last comparison two threads holding the same
  // number of messages come back in whatever order the gateway serialised
  // them, and the list reshuffles between polls.
  const shown = sessions
    .filter((row) => matches(needle, row.peer, row.lastBody, row.deviceId))
    .sort(
      by<SessionRow>(
        (left, right) => (order === "received" ? biggestFirst(left.lastReceivedAt, right.lastReceivedAt) : 0),
        (left, right) => (order === "count" ? biggestFirst(left.count, right.count) : 0),
        (left, right) => alphabetical(left.peer, right.peer),
      ),
    );
  const empty = emptyKind(sessions.length, shown.length, needle);

  return (
    <>
      <LiveReload />
      <div className="mb-6 flex flex-wrap items-start gap-4">
        <div>
          <h1 className="m-0 text-xl font-semibold tracking-tight text-foreground">{t("sessions.title", locale)}</h1>
          <p className="m-0 mt-1 text-sm text-muted-foreground">{t("sessions.desc", locale)}</p>
        </div>
      </div>
      {loadError ? <p className="m-0 mb-4 text-sm text-destructive">{t("sessions.loadError", locale)}</p> : null}

      <Card>
        {/* A plain GET form: the filter is the URL, so this works with no
            JavaScript and a filtered view is a link. */}
        <form className="flex flex-col gap-4" method="get">
          <Field label={t("filter.search", locale)} inline>
            <Input name="q" defaultValue={needle} autoComplete="off" spellCheck={false} />
          </Field>
          <Field label={t("filter.sort", locale)} inline>
            <Select compact name="sort" defaultValue={order}>
              <option value="received">{t("sessions.colLastReceived", locale)}</option>
              <option value="count">{t("sessions.colCount", locale)}</option>
              <option value="peer">{t("sessions.colPeer", locale)}</option>
            </Select>
          </Field>
          <Button type="submit">{t("filter.apply", locale)}</Button>
        </form>
        {/* 🔴 A filter that matched nothing is not an empty dataset. Drawing
            "no threads yet" over a list the reader just filtered is the defect
            app/audit/page.tsx carries a docstring about; `emptyKind` keeps the
            two apart and is tested, which a `.tsx` cannot be. */}
        {empty !== null ? (
          <CardEmpty
            title={t(empty === "noMatch" ? "filter.noMatchTitle" : "empty.sessions.title", locale)}
            description={t(
              empty === "noMatch" ? "filter.noMatchDesc" : "empty.sessions.desc",
              locale,
            )}
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
              {shown.map((row) => (
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
