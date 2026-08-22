"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { EsimProfileRow } from "@/lib/catalog";

type Labels = Record<string, string>;

/**
 * What each eUICC holds, and switching between profiles.
 *
 * Deleted profiles are shown rather than hidden. Which ICCID used to be on a
 * chip is exactly what someone needs when a card stops working after a switch,
 * and an inventory that agrees with the chip while disagreeing with history
 * answers the easy question and not the hard one.
 */
export function EsimPanel({
  deviceId,
  profiles,
  modems,
  labels,
}: {
  deviceId: string;
  profiles: EsimProfileRow[];
  modems: { imei: string }[];
  labels: Labels;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function issue(kind: string, extra: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const response = await fetch("/v1/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_id: deviceId, kind, ...extra }),
    });
    setBusy(false);
    if (!response.ok) {
      setError((await response.text()).trim() || "failed");
      return;
    }
    router.refresh();
  }

  const byEid = new Map<string, EsimProfileRow[]>();
  for (const profile of profiles) {
    byEid.set(profile.eid, [...(byEid.get(profile.eid) ?? []), profile]);
  }

  return (
    <div className="stack">
      <div className="button-row">
        {modems.map((modem) => (
          <button
            key={modem.imei}
            type="button"
            disabled={busy}
            onClick={() => void issue("list_esim_profiles", { modem_imei: modem.imei })}
          >
            {labels.refresh} — {modem.imei}
          </button>
        ))}
      </div>

      {error ? <p className="error">{error}</p> : null}

      {profiles.length === 0 ? (
        <p className="faint">{labels.none}</p>
      ) : (
        [...byEid.entries()].map(([eid, rows]) => (
          <section key={eid} className="stack">
            <h4 className="section-title mono">
              {labels.colEid} {eid}
            </h4>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>{labels.colIccid}</th>
                    <th>{labels.colNickname}</th>
                    <th>{labels.colState}</th>
                    <th>{labels.colCollected}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((profile) => (
                    <tr key={profile.iccid}>
                      <td className="mono">{profile.iccid}</td>
                      <td>{profile.nickname ?? <span className="faint">—</span>}</td>
                      <td>
                        <StateBadge state={profile.state} />
                      </td>
                      <td className="mono faint">
                        {new Date(profile.collectedAt)
                          .toISOString()
                          .replace("T", " ")
                          .slice(0, 16)}
                      </td>
                      <td className="row-actions">
                        {/* Only a disabled profile can be switched to, and a
                            deleted one is not on the chip at all. */}
                        {profile.state === "disabled" && profile.modemImei ? (
                          <button
                            type="button"
                            className="risk"
                            disabled={busy}
                            onClick={() => {
                              if (!window.confirm(labels.confirmSwitch)) return;
                              void issue("switch_esim_profile", {
                                modem_imei: profile.modemImei,
                                target_iccid: profile.iccid,
                              });
                            }}
                          >
                            {labels.switch}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}
    </div>
  );
}

function StateBadge({ state }: { state: string }) {
  const tone =
    state === "enabled"
      ? "badge-ok"
      : state === "deleted"
        ? "badge-bad"
        : "badge-idle";
  return <span className={`badge ${tone}`}>{state}</span>;
}
