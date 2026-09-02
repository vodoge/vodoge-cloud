"use client";

import { Fragment, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Output } from "@/components/ui/output";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHead,
  TableRow,
} from "@/components/ui/table";
import type { JournalEvent } from "@/lib/catalog";
import { cn } from "@/lib/cn";

type Labels = Record<string, string>;

/**
 * How many columns the payload row spans: arrived, kind, seq, the toggle.
 *
 * One of them is `secondary` and is not rendered on a phone, which is fine —
 * a `colspan` wider than the row has is clamped to what is there. Getting it
 * *too small* is the failure that matters, and it leaves a gap on the right.
 */
const PAYLOAD_COLUMNS = 4;

/**
 * What the devices actually said.
 *
 * Every page in this console shows a projection — a modem's state, a message,
 * a traffic figure — and when one looks wrong the question is always whether
 * the device reported it that way or the projection mangled it. This is the
 * only place that answers it, so a row expands to the envelope verbatim rather
 * than to a summary.
 *
 * ## Moved onto the design system
 *
 * Nothing about what this component does has changed: the same filter, the
 * same per-row fetch, the same expand-to-collapse toggle. Two things it used to
 * rely on were not what they looked like:
 *
 * - The filter was `<div className="button-row">` with `segmented-on` on the
 *   selected button, and `segmented-on` is **not a rule** — the stylesheet only
 *   declares `.button-row button.segmented-on`, so it worked because of the
 *   container it happened to be in. `SEGMENTED` needs no ancestor, which is the
 *   same correction the `risk` button variant is to `.risk`. (That variant now
 *   lives in `components/ui/button.tsx`'s `cva`, not in a recipe — the recipe
 *   `BUTTON.variant.risk` this line used to name still sits in `lib/tokens.ts`
 *   with no caller, which is why the name is dropped rather than followed.)
 * - The payload block was `<pre className="output">` inside a table cell. `pre`
 *   is `white-space: pre`, so one long line of an envelope sets the cell's
 *   min-content width to that whole line and the table grows to fit it. That is
 *   the overflow this card was told to deal with.
 *
 *   🔴 **`Output` alone does not fix it**, and that was measured rather than
 *   assumed: at 390px the table came out 1311px wide inside a 311px card with
 *   `Output` in the cell, against 1409px for the `.output` it replaced. A
 *   scroll container's min-content size is not zero for the box sizing the
 *   cell around it. The payload block wraps (`whitespace-pre-wrap break-all`),
 *   which takes the
 *   table to the width of the card; `Output` keeps the vertical ceiling and
 *   the scroll that goes with it.
 */
export function Journal({
  events,
  kinds,
  labels,
}: {
  events: JournalEvent[];
  kinds: string[];
  labels: Labels;
}) {
  const [kind, setKind] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [payloads, setPayloads] = useState<Record<string, unknown>>({});

  const shown = kind ? events.filter((event) => event.kind === kind) : events;

  async function expand(event: JournalEvent) {
    const key = rowKey(event);
    if (open === key) {
      setOpen(null);
      return;
    }
    setOpen(key);
    if (payloads[key] !== undefined) return;
    // Fetched per row rather than with the listing: a page of DeviceState
    // envelopes is a megabyte of JSON, and nearly all of it is never looked at.
    const query = new URLSearchParams({
      payload: "1",
      device_id: event.deviceId,
      limit: "200",
    });
    const response = await fetch(`/v1/journal?${query}`, { cache: "no-store" });
    if (!response.ok) return;
    const body = (await response.json()) as { events?: JournalEvent[] };
    const match = (body.events ?? []).find(
      (candidate) => candidate.seq === event.seq && candidate.deviceId === event.deviceId,
    );
    setPayloads((current) => ({ ...current, [key]: match?.payload ?? null }));
  }

  return (
    <div className="flex flex-col gap-4">
      <div
        className="inline-flex items-center gap-px rounded border border-border bg-surface-hover p-px"
        role="group"
        aria-label={labels.filter}
      >
        <button
          type="button"
          aria-pressed={kind === ""}
          className={cn("inline-flex min-h-touch cursor-pointer items-center rounded border-0 bg-transparent px-3 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground", kind === "" ? "bg-surface text-foreground shadow" : undefined)}
          onClick={() => setKind("")}
        >
          {labels.all}
        </button>
        {kinds.map((candidate) => (
          <button
            key={candidate}
            type="button"
            aria-pressed={kind === candidate}
            className={cn(
              "inline-flex min-h-touch cursor-pointer items-center rounded border-0 bg-transparent px-3 text-xs font-semibold text-muted-foreground transition-colors hover:text-foreground",
              kind === candidate ? "bg-surface text-foreground shadow" : undefined,
            )}
            onClick={() => setKind(candidate)}
          >
            {candidate}
          </button>
        ))}
      </div>

      <Table>
        <TableHeader>
          <TableRow head>
            <TableHead>{labels.colAt}</TableHead>
            <TableHead>{labels.colKind}</TableHead>
            <TableHead secondary>{labels.colSeq}</TableHead>
            {/* The toggle column has no heading, as it had none before. The
                cell itself stays, so the header row still has one cell per
                column. */}
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {shown.map((event) => {
            const key = rowKey(event);
            const expanded = open === key;
            return (
              <Fragment key={key}>
                <TableRow className={expanded ? "border-b-0 bg-surface-hover" : undefined}>
                  <TableCell mono faint>
                    {new Date(event.receivedAt).toISOString().replace("T", " ").slice(0, 19)}
                  </TableCell>
                  <TableCell>
                    <Badge tone="info" dot={false}>
                      {event.kind}
                    </Badge>
                  </TableCell>
                  <TableCell mono faint secondary>
                    {event.seq}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-expanded={expanded}
                      onClick={() => void expand(event)}
                    >
                      {expanded ? labels.hide : labels.show}
                    </Button>
                  </TableCell>
                </TableRow>
                {/* The envelope gets a row of its own across every column
                    rather than the last cell. Inside the cell it had whatever
                    the other three columns left over, which at 390px was
                    measured at 79px — a JSON block the width of a thumbnail.
                    Spanning the row gives it the card. */}
                {expanded ? (
                  <TableRow className="bg-surface-hover">
                    <TableCell colSpan={PAYLOAD_COLUMNS} wrap>
                      <Output className="whitespace-pre-wrap break-all">
                        {payloads[key] === undefined
                          ? labels.loading
                          : JSON.stringify(payloads[key], null, 2)}
                      </Output>
                    </TableCell>
                  </TableRow>
                ) : null}
              </Fragment>
            );
          })}
        </TableBody>
      </Table>

      {/* Only reachable through the filter: the page renders its own empty
          state when nothing arrived at all, so this is "the filter matched
          nothing", which is a different sentence about a different cause. */}
      {shown.length === 0 ? <p className="m-0 text-sm text-muted-foreground">{labels.none}</p> : null}
    </div>
  );
}

// A device's sequence is unique per device, not globally.
function rowKey(event: JournalEvent): string {
  return `${event.deviceId}:${event.seq}`;
}
