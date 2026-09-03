/**
 * `?q=` and `?sort=` for a list page, read on the server.
 *
 * 🔴 **Why this is a `.ts` and not written inline in each page.**
 *
 * `app/devices/page.tsx` already did all of this by hand, and the pattern is
 * worth copying — the work stays on the server, a filtered view is a link
 * somebody can send, and the page keeps working with no JavaScript at all.
 * What is not worth copying seven more times is the *deciding*: which sort
 * values are accepted, what happens to a row with no reading, and whether the
 * order is total. Those three are where this gets silently wrong, and a `.tsx`
 * in this app cannot be tested — there is no jsdom, no testing-library and no
 * `.tsx` runner, by a decision recorded in `docs/frontend-rebuild/README.md`.
 * Put them here and `lib/table-query.test.ts` can actually run them.
 *
 * The same reasoning produced `lib/palette-source.ts`: three copies of one
 * parser are three implementations that drift apart, and this repository has
 * already paid for that shape once.
 */

/**
 * The sort key, or the fallback — never whatever the URL said.
 *
 * 🔴 The return value reaches a comparison and, on some pages, a `defaultValue`
 * echoed back into the markup. An unchecked `?sort=` is therefore both a
 * correctness bug and reflected input. `app/devices/page.tsx` writes this out
 * as `query.sort === "signal" || query.sort === "seen" ? query.sort : "imei"`,
 * which is right but does not survive a fourth option being added.
 */
export function pickSort<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(raw as T) ? (raw as T) : fallback;
}

/** `?q=` reduced to what `matches` compares against: trimmed and folded. */
export function needleOf(raw: string | undefined): string {
  return (raw ?? "").trim().toLowerCase();
}

/**
 * Does this row match the filter?
 *
 * An empty needle matches everything, so a page with no `?q=` shows its whole
 * list rather than nothing. Fields are folded the same way the needle is;
 * `null` and `undefined` are skipped rather than stringified, because
 * searching for "null" should not match every row that is missing a reading.
 */
export function matches(needle: string, ...fields: readonly (string | number | null | undefined)[]) {
  if (needle === "") return true;
  return fields.some(
    (field) => field !== null && field !== undefined && String(field).toLowerCase().includes(needle),
  );
}

/**
 * Compare two readings, largest first, with **missing sorting last**.
 *
 * 🔴 Not "missing counts as zero". A module that could not be measured is not
 * a module with the worst signal in the fleet, and a schedule that has never
 * run is not a schedule that ran at the epoch. `app/devices/page.tsx` records
 * the same rule in its own words; this is that rule, once.
 *
 * Returns 0 when both are missing, so the caller's tiebreaker decides — which
 * is the whole point of `by` below.
 */
export function biggestFirst(left: number | null | undefined, right: number | null | undefined) {
  const a = left ?? null;
  const b = right ?? null;
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return b - a;
}

/**
 * Build a comparator that is a **total order**, from a list of comparisons.
 *
 * 🔴 The last entry has to be one that can never return 0 for two different
 * rows — an id, an IMEI, a name. Without it the sort is unstable across
 * fetches: two rows comparing equal come back in whatever order the gateway
 * happened to serialise them, the list reshuffles between polls, and a row
 * moves out from under the cursor as somebody is about to click it. That is
 * not a theoretical failure; it is why `orderModems` falls through to the
 * IMEI on every branch.
 *
 * This cannot check that the last comparison is total — nothing here can see
 * the data. `lib/table-query.test.ts` pins the property that this function
 * consults every comparison in order and stops at the first non-zero one, and
 * each caller is responsible for ending with a unique key.
 */
export function by<T>(...comparisons: readonly ((left: T, right: T) => number)[]) {
  return (left: T, right: T): number => {
    for (const compare of comparisons) {
      const result = compare(left, right);
      if (result !== 0) return result;
    }
    return 0;
  };
}

/** Compare two strings the way a reader of this locale would order them. */
export function alphabetical(left: string, right: string) {
  return left.localeCompare(right);
}

/**
 * Which empty state a filtered list should draw — or none.
 *
 * 🔴 **A filter that matched nothing is not an empty dataset**, and drawing
 * "nothing recorded yet" over a list that has rows the reader filtered out is
 * the same defect `app/audit/page.tsx` already carries a docstring about: the
 * gateway answered with events, the parser dropped all of them, nothing threw,
 * and the placeholder was drawn over a full audit log. That page fixed it by
 * making rows and placeholder mutually exclusive *by construction*; a filter
 * added on top re-opens it unless the two emptinesses stay distinct.
 *
 * - `"none"` — there is genuinely nothing to show.
 * - `"noMatch"` — there are rows, but this filter excluded all of them. The
 *   reader needs to be told their filter did it, not that the tenant has no
 *   history.
 * - `null` — draw the table.
 */
export function emptyKind(total: number, shown: number, needle: string): "none" | "noMatch" | null {
  if (total === 0) return "none";
  if (shown === 0) return needle === "" ? "none" : "noMatch";
  return null;
}
