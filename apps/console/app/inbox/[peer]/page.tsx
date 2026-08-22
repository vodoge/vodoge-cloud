import Link from "next/link";
import { Conversation } from "@/components/conversation";
import { Card } from "@/components/ui";
import { fetchThread, type ThreadMessage } from "@/lib/catalog";
import { t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";
import { requestHost, sessionToken } from "@/lib/tenant-headers";

export default async function ThreadPage({
  params,
}: {
  params: Promise<{ peer: string }>;
}) {
  const { peer: encoded } = await params;
  const peer = decodeURIComponent(encoded);
  const locale = await getRequestLocale();
  const host = await requestHost();
  const token = await sessionToken();

  let messages: ThreadMessage[] = [];
  let loadError = false;
  try {
    messages = await fetchThread(host, token, peer);
  } catch {
    loadError = true;
  }

  return (
    <>
      <div className="page-head">
        <div>
          <Link href="/inbox" className="back-link">
            ← {t("inbox.title", locale)}
          </Link>
          <h1 className="page-title mono">{peer}</h1>
          <p className="page-desc">
            {messages.length} {t("inbox.messages", locale)}
          </p>
        </div>
      </div>

      {loadError ? <p className="danger">{t("inbox.loadError", locale)}</p> : null}

      <Card className="card-span-all">
        <Conversation
          peer={peer}
          messages={messages}
          labels={{
            remove: t("inbox.remove", locale),
            deleteThread: t("inbox.deleteThread", locale),
            confirmDeleteThread: t("inbox.confirmDeleteThread", locale),
            "status.queued": t("inbox.statusQueued", locale),
            "status.sent": t("inbox.statusSent", locale),
            "status.failed": t("inbox.statusFailed", locale),
            "status.received": t("inbox.statusReceived", locale),
            "encoding.8bit": t("inbox.encoding8bit", locale),
          }}
        />
      </Card>
    </>
  );
}
