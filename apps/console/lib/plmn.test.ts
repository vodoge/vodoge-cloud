import assert from "node:assert/strict";
import { test } from "node:test";
import { isRoaming, operatorName, territoryName } from "./plmn.ts";

// The US profile this product exists to run. Its MNC is three digits, and
// until the edge read the length off the card it cut every IMSI at two: a
// T-Mobile card arrived as "310-26", which is not an operator and which this
// table would have rendered verbatim on the devices page. These assertions
// are the second half of that fix -- the edge can send "310-260" all it likes
// if nothing here knows the name.
test("operatorName names the US networks the edge can now report", () => {
  assert.equal(operatorName("310-260"), "T-Mobile");
  assert.equal(operatorName("310-280"), "AT&T");
  assert.equal(operatorName("310-410"), "AT&T");
  assert.equal(operatorName("311-480"), "Verizon");
});

test("territoryName places a three-digit MNC by its MCC", () => {
  assert.equal(territoryName("310-260"), "美国");
  assert.equal(territoryName("311-480"), "美国");
  // The MCC is the first three characters whether the MNC is two digits or
  // three, which is the only reason slicing at 3 still works for both.
  assert.equal(territoryName("454-00"), "中国香港");
  assert.equal(territoryName("460-02"), "中国大陆");
});

// A PLMN nobody has named is still worth showing: it is what an operator
// would look up. Returning it unchanged is also what makes a wrong split
// visible -- "310-26" appearing on the page is the symptom this whole change
// was chasing, and a table that invented a name for it would have hidden it.
test("operatorName returns an unknown PLMN unchanged", () => {
  assert.equal(operatorName("310-26"), "310-26");
  assert.equal(operatorName("999-99"), "999-99");
  assert.equal(operatorName(""), "");
  assert.equal(territoryName("999-99"), null);
});

// The three cards on the bench. Their home networks are what the console
// shows today and must not move because a US card was taught to work.
test("the bench cards keep the names they show today", () => {
  assert.equal(operatorName("454-00"), "CSL");
  assert.equal(territoryName("454-00"), "中国香港");
  assert.equal(operatorName("460-02"), "中国移动");
  assert.equal(territoryName("460-02"), "中国大陆");
});

test("roaming compares operators, not PLMN strings", () => {
  // 310-260 registered on 310-410 is a T-Mobile card on AT&T's radio.
  assert.equal(isRoaming("310-260", "310-410"), true);
  // AT&T's two PLMNs are the same operator, so this is not roaming.
  assert.equal(isRoaming("310-280", "310-410"), false);
  assert.equal(isRoaming("454-00", "454-00"), false);
});
