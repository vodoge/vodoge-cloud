import { Journal } from "@/components/journal";
import {
  Card,
  CardContent,
  CardEmpty,
  CardHeader,
  CardNote,
} from "@/components/ui/card";
import { fetchJournal, type JournalEvent } from "@/lib/catalog";
import { t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";
import { requestHost, sessionToken } from "@/lib/tenant-headers";
import { PAGE } from "@/lib/tokens";

/**
 * What the devices actually said, one row per envelope.
 *
 * Moved onto the design system. The fetch, the failure case, the empty case and
 * the kinds the filter offers are untouched — the page has one control, a
 * filter, and it writes nothing.
 *
 * The card had a `note` and no title, which the old prop-shaped card allowed
 * and the composed one does not fake: a `CardHeader` holding only a `CardNote`
 * is the same header without a boolean deciding whether the title is there.
 *
 * `locale` is resolved on the server and used directly, never read from a
 * cookie in an effect. This console has shipped that bug twice; it renders the
 * server's HTML in the default language every time while looking correct in a
 * browser, because hydration fixes it before anyone looks.
 */
export default async function JournalPage() {
  const locale = await getRequestLocale();
  const host = await requestHost();
  const token = await sessionToken();

  let events: JournalEvent[] = [];
  let loadError = false;
  try {
    events = await fetchJournal(host, token, { limit: 200 });
  } catch {
    loadError = true;
  }

  // The filter offers what is actually present rather than every kind the
  // contract defines: a filter for something that never arrives is a dead end.
  const kinds = [...new Set(events.map((event) => event.kind))].sort();

  return (
    <>
      <div className={PAGE.head}>
        <div>
          <h1 className={PAGE.title}>{t("journal.title", locale)}</h1>
          <p className={PAGE.description}>{t("journal.desc", locale)}</p>
        </div>
      </div>

      {loadError ? <p className={PAGE.error}>{t("journal.loadError", locale)}</p> : null}

      <Card>
        <CardHeader>
          <CardNote>{t("journal.note", locale)}</CardNote>
        </CardHeader>
        {events.length === 0 ? (
          <CardEmpty title={t("journal.none", locale)} />
        ) : (
          <CardContent>
            <Journal
              events={events}
              kinds={kinds}
              labels={{
                all: t("journal.all", locale),
                colAt: t("journal.colAt", locale),
                colKind: t("journal.colKind", locale),
                colSeq: t("journal.colSeq", locale),
                filter: t("journal.filter", locale),
                show: t("journal.show", locale),
                hide: t("journal.hide", locale),
                loading: t("journal.loading", locale),
                none: t("journal.none", locale),
              }}
            />
          </CardContent>
        )}
      </Card>
    </>
  );
}
