import assert from "node:assert/strict";
import test from "node:test";

import {
  alphabetical,
  biggestFirst,
  by,
  emptyKind,
  matches,
  needleOf,
  pickSort,
} from "./table-query.ts";

/* ── The sort key is never whatever the URL said ─────────────────────── */

test("an unknown sort falls back instead of reaching the comparison", () => {
  const allowed = ["name", "due"] as const;
  assert.equal(pickSort("due", allowed, "name"), "due");
  assert.equal(pickSort("nonsense", allowed, "name"), "name");
  assert.equal(pickSort(undefined, allowed, "name"), "name");
  assert.equal(pickSort("", allowed, "name"), "name");

  // 🔴 Case matters. `?sort=DUE` is not `due`: it would be echoed back into a
  // `defaultValue` as typed while ordering by the fallback, so the control
  // would say one thing and the table would do another.
  assert.equal(pickSort("DUE", allowed, "name"), "name");

  // Nothing off the prototype gets through either.
  assert.equal(pickSort("constructor", allowed, "name"), "name");
  assert.equal(pickSort("toString", allowed, "name"), "name");
});

/* ── The filter ──────────────────────────────────────────────────────── */

test("an absent filter shows the list, not an empty page", () => {
  assert.equal(needleOf(undefined), "");
  assert.equal(needleOf("  "), "");
  assert.equal(needleOf("  DEMO-07 "), "demo-07");

  assert.equal(matches("", "anything"), true);
  assert.equal(matches("", null, undefined), true);
});

test("a missing field is skipped, not stringified", () => {
  // Searching for "null" must not match every row that has no reading — the
  // rows with nothing in that column are exactly the ones a reader is least
  // likely to be looking for by name.
  assert.equal(matches("null", null), false);
  assert.equal(matches("undefined", undefined), false);
  assert.equal(matches("demo", null, "DEMO-07"), true);
  assert.equal(matches("07", null, 407), true);
  assert.equal(matches("nothing", null, undefined, ""), false);
});

/* ── Missing readings sort last, never as zero ───────────────────────── */

test("a reading that could not be taken is not the worst reading", () => {
  assert.ok(biggestFirst(null, -105) > 0, "a missing signal must sort after a measured one");
  assert.ok(biggestFirst(-105, null) < 0);
  assert.equal(biggestFirst(null, null), 0, "two missing readings tie, so the tiebreaker decides");
  assert.ok(biggestFirst(-70, -105) < 0, "the stronger signal comes first");

  // The trap this exists to avoid: treating null as 0 puts an unmeasured
  // module *above* every real reading on a scale that is negative.
  assert.ok(biggestFirst(null, -105) !== 0 - -105);
});

/* ── The order is total, or rows move under the cursor ───────────────── */

test("by() consults each comparison in order and stops at the first answer", () => {
  const calls: string[] = [];
  const record = (name: string, result: number) => () => {
    calls.push(name);
    return result;
  };

  assert.equal(by(record("a", 0), record("b", -1), record("c", 1))({}, {}), -1);
  assert.deepEqual(calls, ["a", "b"], "a comparison after the deciding one still ran");

  assert.equal(by(record("d", 0), record("e", 0))({}, {}), 0, "all equal is a tie, not an error");
});

test("a total order survives the gateway serialising the same rows differently", () => {
  // 🔴 The property every list page depends on. Two rows that tie on the sorted
  // column must still come out in the same order every fetch, or the list
  // reshuffles between polls and a row moves out from under a cursor that was
  // about to click it.
  type Row = { readonly id: string; readonly seen: number | null };
  const rows: Row[] = [
    { id: "c", seen: 5 },
    { id: "a", seen: null },
    { id: "d", seen: 5 },
    { id: "b", seen: null },
    { id: "e", seen: 9 },
  ];
  const order = by<Row>(
    (left, right) => biggestFirst(left.seen, right.seen),
    (left, right) => alphabetical(left.id, right.id),
  );

  const expected = ["e", "c", "d", "a", "b"];
  assert.deepEqual(rows.slice().sort(order).map((row) => row.id), expected);

  // Every permutation of the same rows sorts to the same list.
  const permute = <T,>(items: readonly T[]): T[][] =>
    items.length <= 1
      ? [[...items]]
      : items.flatMap((item, index) =>
          permute([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
        );
  for (const permutation of permute(rows)) {
    assert.deepEqual(
      permutation.sort(order).map((row) => row.id),
      expected,
      "the same rows in a different arrival order sorted differently",
    );
  }
});

test("dropping the tiebreaker is what makes it unstable, so the test above means something", () => {
  type Row = { readonly id: string; readonly seen: number | null };
  const withoutTiebreak = by<Row>((left, right) => biggestFirst(left.seen, right.seen));
  const one = [{ id: "c", seen: 5 }, { id: "d", seen: 5 }].sort(withoutTiebreak).map((r) => r.id);
  const other = [{ id: "d", seen: 5 }, { id: "c", seen: 5 }].sort(withoutTiebreak).map((r) => r.id);
  assert.notDeepEqual(one, other, "the tie is being broken by something, so the guard above is vacuous");
});

/* ── A filter that matched nothing is not an empty dataset ───────────── */

test("filtering to nothing does not claim the tenant has no history", () => {
  // 🔴 The defect this exists to prevent is written down in
  // app/audit/page.tsx: "Nothing recorded yet" was drawn over a full audit
  // log. A filter re-opens that hole unless the two emptinesses are distinct.
  assert.equal(emptyKind(0, 0, ""), "none", "genuinely empty");
  assert.equal(emptyKind(0, 0, "demo"), "none", "empty stays empty even with a filter typed");
  assert.equal(emptyKind(40, 0, "demo"), "noMatch", "40 rows exist; the filter hid them");
  assert.equal(emptyKind(40, 0, ""), "none", "no filter and nothing shown is a real emptiness");
  assert.equal(emptyKind(40, 12, "demo"), null, "draw the table");
  assert.equal(emptyKind(40, 40, ""), null);
});
