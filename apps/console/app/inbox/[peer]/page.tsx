import Link from "next/link";
import { Conversation } from "@/components/conversation";
import { CardPanel as Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { fetchThread, fetchThreads, type ThreadMessage } from "@/lib/catalog";
import { t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";
import { requestHost, sessionToken } from "@/lib/tenant-headers";
import { INBOX, PAGE } from "@/lib/tokens";

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
  let name = "";
  let loadError = false;
  try {
    messages = await fetchThread(host, token, peer);
    // The name comes from the thread list rather than a lookup of its own.
    // One request already knows it, and a second endpoint for one string is
    // a second thing that can disagree with the first.
    name = (await fetchThreads(host, token)).find((thread) => thread.peer === peer)?.name ?? "";
  } catch {
    loadError = true;
  }

  return (
    <>
      <div className={PAGE.head}>
        <div>
          <Link href="/inbox" className={INBOX.backLink}>
            ← {t("inbox.title", locale)}
          </Link>
          {/* The name leads when there is one, with the number kept below:
              an operator checking which SIM answered still needs the digits,
              and a heading that replaced them would hide the one field that
              is unambiguous. */}
          <h1 className={cn(PAGE.title, name ? undefined : INBOX.titleMono)}>{name || peer}</h1>
          <p className={PAGE.description}>
            {name ? <span className={INBOX.peerUnder}>{peer} · </span> : null}
            {messages.length} {t("inbox.messages", locale)}
          </p>
        </div>
      </div>

      {loadError ? <p className={PAGE.error}>{t("inbox.loadError", locale)}</p> : null}

      <Card>
        <Conversation
          peer={peer}
          name={name}
          messages={messages}
          confirmLabels={{
            question: t("confirm.question", locale),
            proceed: t("confirm.proceed", locale),
            cancel: t("confirm.cancel", locale),
          }}
          labels={{
            remove: t("inbox.remove", locale),
            deleteThread: t("inbox.deleteThread", locale),
            confirmDeleteThread: t("inbox.confirmDeleteThread", locale),
            confirmDeleteMessageTitle: t("inbox.confirmDeleteMessageTitle", locale),
            confirmDeleteMessage: t("inbox.confirmDeleteMessage", locale),
            confirmForgetContactTitle: t("inbox.confirmForgetContactTitle", locale),
            confirmForgetContact: t("inbox.confirmForgetContact", locale),
            nameContact: t("inbox.nameContact", locale),
            renameContact: t("inbox.renameContact", locale),
            contactName: t("inbox.contactName", locale),
            save: t("inbox.save", locale),
            cancel: t("inbox.cancel", locale),
            "status.queued": t("inbox.statusQueued", locale),
            "status.sent": t("inbox.statusSent", locale),
            "status.delivered": t("inbox.statusDelivered", locale),
            "status.undelivered": t("inbox.statusUndelivered", locale),
            "status.failed": t("inbox.statusFailed", locale),
            "status.received": t("inbox.statusReceived", locale),
            "encoding.8bit": t("inbox.encoding8bit", locale),
          }}
        />
      </Card>
    </>
  );
}
