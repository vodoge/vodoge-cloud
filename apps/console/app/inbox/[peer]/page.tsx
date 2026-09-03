import Link from "next/link";
import { Conversation } from "@/components/conversation";
import { Badge } from "@/components/ui/badge";
import { CardPanel as Card } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { fetchThread, fetchThreads, type ThreadMessage } from "@/lib/catalog";
import { t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";
import {
  bearerHeader,
  mayWrite,
  roleFromSessionBody,
  SESSION_ENDPOINT,
  type ConsoleRole,
} from "@/lib/session";
import { gatewayBaseUrl } from "@/lib/tenant";
import { requestHost, sessionToken } from "@/lib/tenant-headers";

/**
 * One conversation, and the three ways to change it.
 *
 * Everything a read-only account may do here is reading, so the role is
 * resolved on the server and handed to `Conversation` as a required prop. It is
 * not resolved in the client component: that component is rendered by this
 * page, so a role it fetched for itself would be a second answer to a question
 * this request has already asked, and the two could disagree on the same
 * screen.
 *
 * Before this card the delete and rename controls were drawn for every account.
 * The gateway refused each of those requests — `DELETE` and `PUT` are refused
 * outright for a read-only session at `cmd/gateway/main.go:858` — so no account
 * ever deleted anything it was not allowed to. What is being removed is the
 * offer, not an ability.
 */
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
  const writable = mayWrite(await currentRole(host, token));

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
      <div className="mb-6 flex flex-wrap items-start gap-4">
        <div>
          <Link href="/inbox" className="text-sm text-muted-foreground no-underline hover:text-foreground">
            ← {t("inbox.title", locale)}
          </Link>
          {/* The name leads when there is one, with the number kept below:
              an operator checking which SIM answered still needs the digits,
              and a heading that replaced them would hide the one field that
              is unambiguous. */}
          <h1 className={cn("m-0 text-xl font-semibold tracking-tight text-foreground", name ? undefined : "font-mono")}>{name || peer}</h1>
          <p className="m-0 mt-1 text-sm text-muted-foreground">
            {name ? <span className="font-mono text-xs tabular-nums text-muted-foreground">{peer} · </span> : null}
            {messages.length} {t("inbox.messages", locale)}
          </p>
        </div>
        {writable ? null : (
          <div className="ml-auto flex flex-wrap gap-2">
            <Badge tone="warn" dot={false}>
              {t("role.readOnlyBadge", locale)}
            </Badge>
          </div>
        )}
      </div>

      {loadError ? <p className="m-0 mb-4 text-sm text-destructive">{t("inbox.loadError", locale)}</p> : null}

      <Card>
        <Conversation
          peer={peer}
          name={name}
          messages={messages}
          writable={writable}
          confirmLabels={{
            question: t("confirm.question", locale),
            proceed: t("confirm.proceed", locale),
            cancel: t("confirm.cancel", locale),
          }}
          labels={{
            remove: t("inbox.remove", locale),
            writeFailed: t("inbox.writeFailed", locale),
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
            readOnly: t("role.readOnlyInbox", locale),
          }}
        />
      </Card>
    </>
  );
}

/**
 * The role for this request, from the gateway.
 *
 * Failing closed, and the same eighteen lines as `app/settings/page.tsx` and
 * `app/inbox/page.tsx`. See the note on the copy in `app/inbox/page.tsx`: three
 * copies is one too many and the home for it is `lib/session.ts`, which no card
 * has owned yet. `lib/tokens.test.ts` holds all three to the same two returns.
 */
async function currentRole(host: string, token: string | undefined): Promise<ConsoleRole> {
  try {
    const response = await fetch(`${gatewayBaseUrl()}${SESSION_ENDPOINT}`, {
      headers: {
        accept: "application/json",
        "x-forwarded-host": host,
        ...bearerHeader(token),
      },
      cache: "no-store",
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return "readonly";
    return roleFromSessionBody(await response.json());
  } catch {
    return "readonly";
  }
}
