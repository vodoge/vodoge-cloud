import { Badge } from "@/components/ui/badge";
import { t, type Locale } from "@/lib/i18n";
import { isRoaming, operatorName, territoryFlag, territoryName } from "@/lib/plmn";

/**
 * Which network a module belongs to, and which one it is actually on.
 *
 * Shared because it was written twice, byte for byte, as `ModemNetwork` on the
 * device list and `Network` on the device detail page. Two copies of a
 * rendering rule drift, and the names having already drifted while the bodies
 * had not is what that looks like just before it happens: the next change lands
 * in one of them.
 *
 * The two PLMNs are shown as one thing on purpose. A card's home operator is
 * what its capabilities are decided against -- the matrix is keyed on the home
 * carrier, never the serving one -- while the serving operator is where it
 * actually is. Reading them apart is how a roaming card looks fine on one page
 * and inexplicable on another.
 */
export function ModemNetwork({
  home,
  serving,
  locale,
}: {
  home: string | null;
  serving: string | null;
  locale: Locale;
}) {
  if (!home && !serving) return <span className="text-muted-foreground">—</span>;
  const identity = home ?? serving!;
  const territory = territoryName(identity);
  // Decorative: the territory name beside it already says the same thing, and
  // a screen reader spelling out "regional indicator symbol letter U" helps
  // nobody.
  const flag = territoryFlag(identity);
  const roaming = home !== null && serving !== null && isRoaming(home, serving);
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span>
        {flag ? <span aria-hidden="true">{flag} </span> : null}
        {operatorName(identity)}
        {territory ? <span className="text-muted-foreground"> · {territory}</span> : null}
      </span>
      {roaming ? (
        <Badge tone="warn">
          {t("modems.roaming", locale)} →{" "}
          {territoryFlag(serving) ? (
            <span aria-hidden="true">{territoryFlag(serving)} </span>
          ) : null}
          {operatorName(serving)}
        </Badge>
      ) : null}
    </span>
  );
}
