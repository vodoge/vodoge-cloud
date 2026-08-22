import { Journal } from "@/components/journal";
import { Card, EmptyState } from "@/components/ui";
import { fetchJournal, type JournalEvent } from "@/lib/catalog";
import { t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";
import { requestHost, sessionToken } from "@/lib/tenant-headers";

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
      <div className="page-head">
        <div>
          <h1 className="page-title">{t("journal.title", locale)}</h1>
          <p className="page-desc">{t("journal.desc", locale)}</p>
        </div>
      </div>

      {loadError ? <p className="danger">{t("journal.loadError", locale)}</p> : null}

      <Card className="card-span-all" note={t("journal.note", locale)}>
        {events.length === 0 ? (
          <EmptyState title={t("journal.none", locale)} />
        ) : (
          <Journal
            events={events}
            kinds={kinds}
            labels={{
              all: t("journal.all", locale),
              colAt: t("journal.colAt", locale),
              colKind: t("journal.colKind", locale),
              colSeq: t("journal.colSeq", locale),
              show: t("journal.show", locale),
              hide: t("journal.hide", locale),
              loading: t("journal.loading", locale),
              none: t("journal.none", locale),
            }}
          />
        )}
      </Card>
    </>
  );
}
