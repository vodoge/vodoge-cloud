"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Output } from "@/components/ui/output";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@/components/ui/table";
import type { JournalEvent } from "@/lib/catalog";
import { cn } from "@/lib/cn";
import { JOURNAL, SEGMENTED } from "@/lib/tokens";

type Labels = Record<string, string>;

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
 *   same correction `BUTTON.variant.risk` is to `.risk`.
 * - The payload block was `<pre className="output">` inside a table cell. `pre`
 *   is `white-space: pre`, so one long line of an envelope sets the cell's
 *   min-content width to that whole line and the table grows to fit it. That is
 *   the overflow this card was told to deal with, and `Output` is the primitive
 *   built for it — a scroll container of its own, in both axes.
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
    <div className={JOURNAL.stack}>
      <div className={SEGMENTED.root} role="group" aria-label={labels.filter}>
        <button
          type="button"
          aria-pressed={kind === ""}
          className={cn(SEGMENTED.option, kind === "" ? SEGMENTED.optionSelected : undefined)}
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
              SEGMENTED.option,
              kind === candidate ? SEGMENTED.optionSelected : undefined,
            )}
            onClick={() => setKind(candidate)}
          >
            {candidate}
          </button>
        ))}
      </div>

      <Table>
        <TableHead>
          <TableRow head>
            <TableHeaderCell>{labels.colAt}</TableHeaderCell>
            <TableHeaderCell>{labels.colKind}</TableHeaderCell>
            <TableHeaderCell secondary>{labels.colSeq}</TableHeaderCell>
            {/* The toggle column has no heading, as it had none before. The
                cell itself stays, so the header row still has one cell per
                column. */}
            <TableHeaderCell />
          </TableRow>
        </TableHead>
        <TableBody>
          {shown.map((event) => {
            const key = rowKey(event);
            return (
              <TableRow key={key}>
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
                {/* `wrap` is what keeps the expanded payload from setting this
                    column's width: `Output` scrolls, and the cell around it is
                    allowed to be narrower than the longest line in it. */}
                <TableCell wrap>
                  <Button
                    variant="subtle"
                    size="sm"
                    aria-expanded={open === key}
                    onClick={() => void expand(event)}
                  >
                    {open === key ? labels.hide : labels.show}
                  </Button>
                  {open === key ? (
                    <Output>
                      {payloads[key] === undefined
                        ? labels.loading
                        : JSON.stringify(payloads[key], null, 2)}
                    </Output>
                  ) : null}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>

      {/* Only reachable through the filter: the page renders its own empty
          state when nothing arrived at all, so this is "the filter matched
          nothing", which is a different sentence about a different cause. */}
      {shown.length === 0 ? <p className={JOURNAL.filteredOut}>{labels.none}</p> : null}
    </div>
  );
}

// A device's sequence is unique per device, not globally.
function rowKey(event: JournalEvent): string {
  return `${event.deviceId}:${event.seq}`;
}
