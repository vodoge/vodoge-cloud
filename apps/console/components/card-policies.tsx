"use client";

import { useRouter } from "next/navigation";
import { Fragment, useState } from "react";
import { Button } from "@/components/ui/button";
import { RowActions } from "@/components/ui/button-row";
import { ConfirmDialog, type ConfirmLabels } from "@/components/ui/confirm-dialog";
import { Field, FormError, InlineField, InlineForm, Select } from "@/components/ui/form";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHead,
  TableRow,
} from "@/components/ui/table";
import type { CardPolicyRow } from "@/lib/catalog";
import {
  CARD_CAPABILITY_OPERATIONS,
  type CardCapabilityOperation,
} from "@/lib/card-capability";
import {
  cardPolicyGuardFor,
  cardPolicyPatch,
  type CardPolicyEdit,
  type CardPolicyGuard,
} from "@/lib/tokens";

/**
 * The declaration this request should carry: the edit's, or the row's when the
 * edit did not touch it.
 *
 * Written out rather than `??` because all three states travel here and `null`
 * is one of them.
 */
function declared(edited: boolean | null | undefined, existing: boolean | null | undefined) {
  return edited !== undefined ? edited : (existing ?? null);
}

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
 * ## `writable`, added by T034
 *
 * All five edits are refused for a read-only session at the gateway's one
 * chokepoint, and until this card all five were still drawn — so an operator
 * signed in as `viewer@vodoge.com` was shown a tick that takes cellular data
 * away from a SIM fleet-wide and a button that deletes its policy, both of
 * which could only ever end in a 403. **Nothing is being made safe here that
 * was not already safe.** What is removed is the offer.
 *
 * Read-only keeps the table and loses the controls, which is the settings
 * page's rule: read-only is not "cannot see". The tick becomes the word it
 * stood for, the picker becomes the vertical it was set to, and the column of
 * Remove buttons goes — header and cells together, so the table is not left a
 * column wider than it has values for.
 *
 * 🔴 **The prop is required rather than defaulted.** `writable = true` means a
 * caller who forgets it draws every control, which is the failure this exists
 * to remove; `writable = false` would be safe and silent, and a policy table
 * nobody can edit looks like a bug rather than like a missing argument. So
 * neither: the compiler asks.
 *
 * The gate is in three places on purpose. The controls are not drawn, `propose`
 * refuses to open a dialog, and `save`/`removePolicy` refuse to send. Only the
 * first is visible, and it is the one a later change is most likely to undo.
 *
 * ## What did not change
 *
 * Both requests are the ones this component always sent — same endpoint, same
 * method, same four body fields, same defaulting for a card that has no policy
 * yet, same `router.refresh()` afterwards. The only new behaviour is the
 * question in front of them, and — this card — the `DELETE` no longer throwing
 * its answer away; see `removePolicy`.
 */
export function CardPolicies({
  policies,
  knownCards,
  writable,
  labels,
  confirmLabels,
  confirmations,
}: {
  policies: CardPolicyRow[];
  knownCards: { iccid: string; label: string }[];
  /** Whether this account may change a policy. Required; see above. */
  writable: boolean;
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
    if (!writable) return;
    const guard = cardPolicyGuardFor(change);
    if (guard === null) return;
    setError(null);
    setPending({ iccid, change, guard });
  }

  async function save(iccid: string, patch: Partial<CardPolicyRow>) {
    if (!writable) return;
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
        // `??` is wrong for these: null is a value here — it clears the
        // declaration back to undeclared — so an edit that sets one to null
        // would fall through to the existing value and appear to do nothing.
        sms_send: declared(patch.smsSend, existing?.smsSend),
        sms_receive: declared(patch.smsReceive, existing?.smsReceive),
        data: declared(patch.data, existing?.data),
        voice: declared(patch.voice, existing?.voice),
      }),
    });
    setBusy(false);
    if (!response.ok) {
      setError((await response.text()).trim() || labels.failed);
      return;
    }
    router.refresh();
  }

  /**
   * 🔴 The `DELETE` used to throw its own answer away.
   *
   * `await fetch(…)` with nothing read off it, then `router.refresh()`
   * unconditionally — so a refusal drew the row back exactly as a success drew
   * it away, and the operator's only evidence of which had happened was
   * whether the policy was still there afterwards. On a table whose rows are
   * twenty-digit ICCIDs that is not evidence.
   *
   * The gateway has a reason for every one of them: a read-only session is
   * refused at the chokepoint, a card whose policy another operator removed a
   * moment ago is a 404, and an upstream that is down is a 502. Each of those
   * is worth a sentence and none of them was being shown.
   *
   * It is the same four lines `save` has had all along, and deliberately not a
   * new idea about failure. The family this belongs to is the one T005 fixed
   * on the edge panel: taking an endpoint's answer as the result rather than
   * assuming the answer.
   */
  async function removePolicy(iccid: string) {
    if (!writable) return;
    setPending(null);
    setBusy(true);
    setError(null);
    const response = await fetch(`/v1/cards/${iccid}/policy`, { method: "DELETE" });
    setBusy(false);
    if (!response.ok) {
      setError((await response.text()).trim() || labels.failed);
      return;
    }
    router.refresh();
  }

  const asked = pending === null ? null : confirmations[pending.guard];

  return (
    <div className="flex flex-col gap-6">
      {error ? <FormError>{error}</FormError> : null}

      {policies.length === 0 ? (
        <p className="m-0 text-sm text-muted-foreground">{labels.none}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow head>
              <TableHead>{labels.colIccid}</TableHead>
              <TableHead>{labels.colCellular}</TableHead>
              <TableHead>{labels.colVertical}</TableHead>
              {/* The only reading in this table, and therefore the only column
                  that may drop off a phone. The other four each hold a control,
                  and hiding a control is not deprioritising context. */}
              <TableHead secondary>{labels.colApn}</TableHead>
              {/* The only layer that separates two cards on one network in
                  one module. Secondary because it is four controls wide and
                  the phone has no room for it beside the identity. */}
              <TableHead secondary title={labels.capabilityHint}>
                {labels.colCapability}
              </TableHead>
              {/* The actions column goes as a column, header and cells
                  together. Leaving the header behind would leave the table a
                  column wider than it has values for. */}
              {writable ? <TableHead label={labels.colActions} /> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {policies.map((policy) => (
              <TableRow key={policy.iccid}>
                <TableCell mono>{policy.iccid}</TableCell>
                <TableCell>
                  {/* The word the tick stood for, not a disabled tick. A
                      control that cannot be operated still reads as an offer,
                      and there is nothing here for this account to do. */}
                  {writable ? (
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
                  ) : (
                    <span>{policy.cellularEnabled ? labels.on : labels.off}</span>
                  )}
                </TableCell>
                <TableCell>
                  {writable ? (
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
                  ) : (
                    <span>{policy.vertical}</span>
                  )}
                </TableCell>
                <TableCell mono faint secondary>
                  {policy.apn ?? "—"}
                </TableCell>
                <TableCell secondary>
                  <PlanCapability
                    policy={policy}
                    labels={labels}
                    mayWrite={writable}
                    busy={busy}
                    onPropose={(edit) => propose(policy.iccid, edit)}
                  />
                </TableCell>
                {writable ? (
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
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {/* The add form, or the sentence that stands where it was. A read-only
          account that is told nothing is left looking for a control that is
          simply not there any more. */}
      {writable ? (
        unpolicied.length > 0 ? (
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
        ) : null
      ) : (
        <p className="m-0 text-sm text-muted-foreground">{labels.readOnly}</p>
      )}

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

/**
 * The plan declaration for one card: four operations, three states each.
 *
 * A `<Select>` rather than a tick, because a tick has two states and this has
 * three. "Undeclared" and "not included" are different records — the first
 * withholds nothing and leaves the module and the network to decide, the
 * second stops the edge attempting the operation at all — and a checkbox
 * would have to pick one of them to mean "unticked", which is exactly the
 * collapse this column exists to avoid.
 *
 * The `{writable ? … : …}` is written in that shape on purpose: `tokens.test.ts`
 * proves every control here is drawn only for an account that may write by
 * reading the braces it sits in, and a `return writable ? …` inside the map
 * callback is the same logic in a shape the proof cannot see.
 */
function PlanCapability({
  policy,
  labels,
  // Renamed on the way in, both directions on purpose. The prop is `mayWrite`
  // because the suite scans this file for `writable=`, which is how a
  // defaulted fail-open prop was caught once and which a JSX attribute reads
  // exactly like. The local is `writable` because that same suite requires
  // every control to sit behind a branch on that identifier.
  mayWrite: writable,
  busy,
  onPropose,
}: {
  policy: CardPolicyRow;
  labels: Labels;
  mayWrite: boolean;
  busy: boolean;
  onPropose: (edit: CardPolicyEdit) => void;
}) {
  const value = (operation: CardCapabilityOperation): boolean | null => {
    switch (operation) {
      case "smsSend":
        return policy.smsSend;
      case "smsReceive":
        return policy.smsReceive;
      case "data":
        return policy.data;
      case "voice":
        return policy.voice;
    }
  };
  const shown = (state: boolean | null) =>
    state === null
      ? labels.capabilityUndeclared
      : state
        ? labels.capabilityYes
        : labels.capabilityNo;
  const nameOf = (operation: CardCapabilityOperation) =>
    labels[capabilityLabelSlot(operation)] ?? operation;

  return (
    <>
      {CARD_CAPABILITY_OPERATIONS.map((operation) => (
        <Fragment key={operation}>
          {writable ? (
            <Field label={nameOf(operation)} inline>
              <Select
                compact
                aria-label={nameOf(operation)}
                value={
                  value(operation) === null ? "" : value(operation) ? "yes" : "no"
                }
                disabled={busy}
                onChange={(event) =>
                  onPropose({
                    kind: "capability",
                    operation,
                    value: event.target.value === "" ? null : event.target.value === "yes",
                  })
                }
              >
                <option value="">{labels.capabilityUndeclared}</option>
                <option value="yes">{labels.capabilityYes}</option>
                <option value="no">{labels.capabilityNo}</option>
              </Select>
            </Field>
          ) : (
            <span>
              {nameOf(operation)}: {shown(value(operation))}
            </span>
          )}
        </Fragment>
      ))}
    </>
  );
}

/** Which resolved label names one operation. */
function capabilityLabelSlot(operation: CardCapabilityOperation): string {
  switch (operation) {
    case "smsSend":
      return "capabilitySmsSend";
    case "smsReceive":
      return "capabilitySmsReceive";
    case "data":
      return "capabilityData";
    case "voice":
      return "capabilityVoice";
  }
}
