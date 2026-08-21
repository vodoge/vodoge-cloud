/**
 * Layout primitives.
 *
 * These exist so a new feature is a card dropped into a grid rather than a
 * fresh arrangement of divs. Keeping them here also keeps the class names in
 * one place: a page that invents its own card is the first step back to every
 * page looking different.
 */

export function Card({
  title,
  note,
  actions,
  className,
  bodyless,
  children,
}: {
  title?: string;
  note?: string;
  actions?: React.ReactNode;
  className?: string;
  /** Skip the padded body, for a card whose content is a full-bleed table. */
  bodyless?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className={className ? `card ${className}` : "card"}>
      {title ? (
        <header className="card-head">
          <h2 className="card-title">{title}</h2>
          {note ? <span className="card-note">{note}</span> : null}
          {actions ? <div className="card-actions">{actions}</div> : null}
        </header>
      ) : null}
      {bodyless ? children : <div className="card-body">{children}</div>}
    </section>
  );
}

/**
 * One number per card.
 *
 * `tone` is only for values that carry a judgement. Colouring a neutral count
 * spends the reader's attention on something that does not need it.
 */
export function StatCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: number | string;
  hint?: string;
  tone?: "ok" | "warn" | "bad";
}) {
  return (
    <section className="card">
      <div className="stat">
        <span className="stat-label">{label}</span>
        <span className={tone ? `stat-value is-${tone}` : "stat-value"}>{value}</span>
        {hint ? <span className="stat-hint">{hint}</span> : null}
      </div>
    </section>
  );
}

/**
 * Says what would be here, not just that nothing is.
 *
 * "No rows" leaves the reader unsure whether the page is empty or broken.
 */
export function EmptyState({ title, desc }: { title: string; desc?: string }) {
  return (
    <div className="empty">
      <span className="empty-title">{title}</span>
      {desc ? <span className="empty-desc">{desc}</span> : null}
    </div>
  );
}

const TONE_BY_STATE: Record<string, string> = {
  online: "badge-ok",
  registered: "badge-ok",
  offline: "badge-idle",
  busy: "badge-warn",
  searching: "badge-warn",
  denied: "badge-bad",
  error: "badge-bad",
};

/** Status pill. Unknown states fall back to neutral rather than guessing. */
export function StateBadge({ state, label }: { state: string; label?: string }) {
  const tone = TONE_BY_STATE[state.toLowerCase()] ?? "badge-idle";
  return <span className={`badge ${tone}`}>{label ?? state}</span>;
}
