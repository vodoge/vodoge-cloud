import Link from "next/link";
import { StateBadge } from "@/components/ui/badge";
import { Card, CardEmpty } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHead,
  TableRow,
} from "@/components/ui/table";
import { fetchRules, type RuleRow } from "@/lib/catalog";
import { t } from "@/lib/i18n";
import { getRequestLocale } from "@/lib/request-locale";
import { requestHost, sessionToken } from "@/lib/tenant-headers";

/**
 * The tenant's own extract rules, read-only.
 *
 * Moved onto the design system. The fetch, the failure case, the empty case
 * and the pointer to `/schedule` are untouched — this page has no controls and
 * writes nothing.
 *
 * `locale` is resolved on the server and used directly, never read from a
 * cookie in an effect. This console has shipped that bug twice; it renders the
 * server's HTML in the default language every time while looking correct in a
 * browser, because hydration fixes it before anyone looks.
 */
export default async function RulesPage() {
  const locale = await getRequestLocale();
  const host = await requestHost();
  const token = await sessionToken();
  let rules: RuleRow[] = [];
  let loadError = false;
  try {
    rules = await fetchRules(host, token);
  } catch {
    loadError = true;
  }

  return (
    <>
      <div className="mb-6 flex flex-wrap items-start gap-4">
        <div>
          <h1 className="m-0 text-xl font-semibold tracking-tight text-foreground">{t("rules.title", locale)}</h1>
          <p className="m-0 mt-1 text-sm text-muted-foreground">{t("rules.desc", locale)}</p>
        </div>
      </div>
      {loadError ? <p className="m-0 mb-4 text-sm text-destructive">{t("rules.loadError", locale)}</p> : null}

      <div className="flex flex-col gap-6">
        {/*
          Scheduled tasks reach the operator from here rather than from the top
          nav. Rules and schedules are the two halves of automation -- one reacts
          to what arrives, the other acts on a clock -- and this is the page an
          operator is already on when they go looking for the second one.
        */}
        <p className="m-0 text-sm text-muted-foreground">
          <Link className="font-semibold text-brand underline" href="/schedule">
            {t("rules.schedules", locale)}
          </Link>{" "}
          {t("rules.schedulesHint", locale)}
        </p>

        <Card>
          {rules.length === 0 ? (
            <CardEmpty
              title={t("empty.rules.title", locale)}
              description={t("empty.rules.desc", locale)}
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow head>
                  <TableHead>{t("rules.colName", locale)}</TableHead>
                  <TableHead secondary>{t("rules.colId", locale)}</TableHead>
                  <TableHead>{t("rules.colEnabled", locale)}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rules.map((rule) => (
                  <TableRow key={rule.id}>
                    <TableCell wrap>{rule.name}</TableCell>
                    <TableCell mono faint secondary>
                      {rule.id}
                    </TableCell>
                    <TableCell>
                      <StateBadge
                        state={rule.enabled ? "online" : "offline"}
                        label={t(rule.enabled ? "rules.on" : "rules.off", locale)}
                      />
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
