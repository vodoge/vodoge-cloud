"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { RowActions } from "@/components/ui/button-row";
import { ConfirmDialog, type ConfirmLabels } from "@/components/ui/confirm-dialog";
import { Field, FormError, InlineField, InlineForm, Select } from "@/components/ui/form";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from "@/components/ui/table";
import type { CardPolicyRow } from "@/lib/catalog";
import {
  cardPolicyGuardFor,
  cardPolicyPatch,
  FORM,
  PAGE,
  type CardPolicyEdit,
  type CardPolicyGuard,
} from "@/lib/tokens";

type Labels = Record<string, string>;

/** The copy for one dialog, already resolved in the reader's language. */
type Confirmation = { title: string; consequence: string };

/** An edit somebody has started but not yet answered for. */
type Pending = { iccid: string; change: CardPolicyEdit; guard: CardPolicyGuard };

/**
 * Per-card policy, edited against the cards the fleet has actually reported.
 *
 * Offering the known ICCIDs rather than a free-text box is the point: a policy
 * for a card that does not exist is pushed to every device and matches none of
 * them, which is a silent no-op — the worst kind of mistake, because nothing
 * ever reports it.
 *
 * ## 🔴 There was no save button, and there was no question either
 *
 * The tick and the picker in each row called `save()` from their own
 * `onChange`, so a stray tap on a phone was a `PUT` to every device in the
 * tenant before the finger left the glass. Clearing the tick takes cellular
 * data away from that SIM fleet-wide. T021's list of dangerous actions does not
 * contain this one; T030 found it by reading the file.
 *
 * Now there is exactly one way from a control to the gateway:
 *
 *     control → propose() → setPending() → <ConfirmDialog> → save/removePolicy
 *
 * `propose` cannot send anything. It asks `cardPolicyGuardFor` which dialog the
 * edit needs and either opens that dialog or drops the edit; `save` and
 * `removePolicy` are named in the dialog's `onConfirm` and in no other handler,
 * which is what `tokens.test.ts` checks by call site. A dialog that still
 * exists while somebody has wired a control straight back to `save` is the
 * failure mode that keeps every other kind of guard green, so that is the one
 * being tested.
 *
 * Cancelling sends nothing and needs no undo: both controls are controlled by
 * the row they render, so the re-render that closes the dialog puts the tick
 * and the picker back where they were.
 *
 * ## What did not change
 *
 * Both requests are the ones this component always sent — same endpoint, same
 * method, same four body fields, same defaulting for a card that has no policy
 * yet, same `router.refresh()` afterwards, same silent `DELETE`. The only new
 * behaviour is the question in front of them.
 */
export function CardPolicies({
  policies,
  knownCards,
  labels,
  confirmLabels,
  confirmations,
}: {
  policies: CardPolicyRow[];
  knownCards: { iccid: string; label: string }[];
  labels: Labels;
  confirmLabels: ConfirmLabels;
  confirmations: Record<CardPolicyGuard, Confirmation>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  const unpolicied = knownCards.filter(
    (card) => !policies.some((policy) => policy.iccid === card.iccid),
  );

  /**
   * The only entry point a control has, and it cannot reach the gateway.
   *
   * Every branch here ends in state: a dialog, or nothing at all. There is no
   * `else` that sends.
   */
  function propose(iccid: string, change: CardPolicyEdit) {
    const guard = cardPolicyGuardFor(change);
    if (guard === null) return;
    setError(null);
    setPending({ iccid, change, guard });
  }

  async function save(iccid: string, patch: Partial<CardPolicyRow>) {
    const existing = policies.find((policy) => policy.iccid === iccid);
    setPending(null);
    setBusy(true);
    setError(null);
    const response = await fetch(`/v1/cards/${iccid}/policy`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cellular_enabled: patch.cellularEnabled ?? existing?.cellularEnabled ?? true,
        vertical: patch.vertical ?? existing?.vertical ?? "cn",
        apn: patch.apn ?? existing?.apn ?? null,
        note: patch.note ?? existing?.note ?? "",
      }),
    });
    setBusy(false);
    if (!response.ok) {
      setError((await response.text()).trim() || labels.failed);
      return;
    }
    router.refresh();
  }

  async function removePolicy(iccid: string) {
    setPending(null);
    setBusy(true);
    await fetch(`/v1/cards/${iccid}/policy`, { method: "DELETE" });
    setBusy(false);
    router.refresh();
  }

  const asked = pending === null ? null : confirmations[pending.guard];

  return (
    <div className={PAGE.stack}>
      {error ? <FormError>{error}</FormError> : null}

      {policies.length === 0 ? (
        <p className={FORM.hint}>{labels.none}</p>
      ) : (
        <Table>
          <TableHead>
            <TableRow head>
              <TableHeaderCell>{labels.colIccid}</TableHeaderCell>
              <TableHeaderCell>{labels.colCellular}</TableHeaderCell>
              <TableHeaderCell>{labels.colVertical}</TableHeaderCell>
              {/* The only reading in this table, and therefore the only column
                  that may drop off a phone. The other four each hold a control,
                  and hiding a control is not deprioritising context. */}
              <TableHeaderCell secondary>{labels.colApn}</TableHeaderCell>
              <TableHeaderCell />
            </TableRow>
          </TableHead>
          <TableBody>
            {policies.map((policy) => (
              <TableRow key={policy.iccid}>
                <TableCell mono>{policy.iccid}</TableCell>
                <TableCell>
                  <InlineField
                    label={policy.cellularEnabled ? labels.on : labels.off}
                    checked={policy.cellularEnabled}
                    disabled={busy}
                    onChange={(event) =>
                      propose(policy.iccid, {
                        kind: "cellular",
                        enabled: event.target.checked,
                      })
                    }
                  />
                </TableCell>
                <TableCell>
                  <Select
                    compact
                    value={policy.vertical}
                    disabled={busy}
                    onChange={(event) =>
                      propose(policy.iccid, {
                        kind: "vertical",
                        from: policy.vertical,
                        to: event.target.value,
                      })
                    }
                  >
                    <option value="cn">cn</option>
                    <option value="intl">intl</option>
                  </Select>
                </TableCell>
                <TableCell mono faint secondary>
                  {policy.apn ?? "—"}
                </TableCell>
                <TableCell>
                  <RowActions>
                    <Button
                      variant="risk"
                      size="sm"
                      disabled={busy}
                      onClick={() => propose(policy.iccid, { kind: "remove" })}
                    >
                      {labels.remove}
                    </Button>
                  </RowActions>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {unpolicied.length > 0 ? (
        <InlineForm
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const iccid = String(form.get("iccid") ?? "");
            if (iccid) propose(iccid, { kind: "add" });
          }}
        >
          <Field inline label={labels.addFor}>
            <Select name="iccid" required>
              {unpolicied.map((card) => (
                <option key={card.iccid} value={card.iccid}>
                  {card.label}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" disabled={busy}>
            {labels.add}
          </Button>
        </InlineForm>
      ) : null}

      {pending !== null && asked !== null ? (
        <ConfirmDialog
          open
          // The card is named in the title, because "this card" in a dialog
          // that covers the row it came from is not an identification.
          title={`${asked.title} · ${pending.iccid}`}
          consequence={asked.consequence}
          labels={confirmLabels}
          busy={busy}
          onConfirm={() =>
            pending.change.kind === "remove"
              ? void removePolicy(pending.iccid)
              : void save(pending.iccid, cardPolicyPatch(pending.change))
          }
          onCancel={() => setPending(null)}
        />
      ) : null}
    </div>
  );
}
