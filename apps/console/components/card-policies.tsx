"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { CardPolicyRow } from "@/lib/catalog";

type Labels = Record<string, string>;

/**
 * Per-card policy, edited against the cards the fleet has actually reported.
 *
 * Offering the known ICCIDs rather than a free-text box is the point: a policy
 * for a card that does not exist is pushed to every device and matches none of
 * them, which is a silent no-op — the worst kind of mistake, because nothing
 * ever reports it.
 */
export function CardPolicies({
  policies,
  knownCards,
  labels,
}: {
  policies: CardPolicyRow[];
  knownCards: { iccid: string; label: string }[];
  labels: Labels;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const unpolicied = knownCards.filter(
    (card) => !policies.some((policy) => policy.iccid === card.iccid),
  );

  async function save(iccid: string, patch: Partial<CardPolicyRow>) {
    const existing = policies.find((policy) => policy.iccid === iccid);
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

  async function remove(iccid: string) {
    if (!window.confirm(labels.confirmRemove)) return;
    setBusy(true);
    await fetch(`/v1/cards/${iccid}/policy`, { method: "DELETE" });
    setBusy(false);
    router.refresh();
  }

  return (
    <div className="stack">
      {error ? <p className="error">{error}</p> : null}

      {policies.length === 0 ? (
        <p className="faint">{labels.none}</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>{labels.colIccid}</th>
                <th>{labels.colCellular}</th>
                <th>{labels.colVertical}</th>
                <th>{labels.colApn}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {policies.map((policy) => (
                <tr key={policy.iccid}>
                  <td className="mono">{policy.iccid}</td>
                  <td>
                    <label className="field-inline">
                      <input
                        type="checkbox"
                        checked={policy.cellularEnabled}
                        disabled={busy}
                        onChange={(event) =>
                          void save(policy.iccid, { cellularEnabled: event.target.checked })
                        }
                      />
                      <span>{policy.cellularEnabled ? labels.on : labels.off}</span>
                    </label>
                  </td>
                  <td>
                    <select
                      value={policy.vertical}
                      disabled={busy}
                      onChange={(event) =>
                        void save(policy.iccid, { vertical: event.target.value })
                      }
                    >
                      <option value="cn">cn</option>
                      <option value="intl">intl</option>
                    </select>
                  </td>
                  <td className="mono faint">{policy.apn ?? "—"}</td>
                  <td className="row-actions">
                    <button
                      type="button"
                      className="risk"
                      disabled={busy}
                      onClick={() => void remove(policy.iccid)}
                    >
                      {labels.remove}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {unpolicied.length > 0 ? (
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const iccid = String(form.get("iccid") ?? "");
            if (iccid) void save(iccid, { cellularEnabled: true, vertical: "cn" });
          }}
        >
          <label className="field grow">
            <span>{labels.addFor}</span>
            <select name="iccid" required>
              {unpolicied.map((card) => (
                <option key={card.iccid} value={card.iccid}>
                  {card.label}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={busy}>
            {labels.add}
          </button>
        </form>
      ) : null}
    </div>
  );
}
