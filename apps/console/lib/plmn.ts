// Readable names for the networks a modem reports, mirroring the table the
// edge keeps in edge-core/src/network.rs: the networks this product actually
// meets, with the numeric pair as the fallback for everything else.
//
// Mirroring means the two lists drift, and the drift is silent: a PLMN this
// one has not heard of renders as a bare "310-260" on a page that otherwise
// shows operator names, and nothing fails. Anything added there belongs here
// in the same change.
//
// The edge sends "460-01" style PLMN strings rather than names on purpose —
// operator brands are neither unique nor stable, the numeric pair is — so
// naming them is presentation work and belongs here.
const OPERATORS: Record<string, string> = {
  // United States. Every US MNC here is three digits, which is why the edge
  // reads the MNC length off EF_AD rather than cutting the IMSI at two: a
  // T-Mobile card sliced at two arrives as "310-26" and matches nothing here.
  //
  // No entry has a leading zero in its MNC on purpose. The edge renders the
  // MNC with a minimum width of two, so 310-004 would arrive as "310-04";
  // a key spelled that way would hide that rather than fix it.
  "310-260": "T-Mobile",
  "310-410": "AT&T",
  "310-280": "AT&T",
  "311-480": "Verizon",
  // Mainland China
  "460-00": "中国移动",
  "460-02": "中国移动",
  "460-04": "中国移动",
  "460-07": "中国移动",
  "460-08": "中国移动",
  "460-01": "中国联通",
  "460-06": "中国联通",
  "460-09": "中国联通",
  "460-03": "中国电信",
  "460-05": "中国电信",
  "460-11": "中国电信",
  "460-15": "中国广电",
  "460-20": "中国铁通",
  // Hong Kong
  "454-00": "CSL",
  "454-02": "CSL",
  "454-10": "CSL",
  "454-18": "CSL",
  "454-03": "3 HK",
  "454-04": "3 HK",
  "454-06": "SmarTone",
  "454-12": "中国移动香港",
  "454-13": "中国移动香港",
  "454-16": "csl. PCCW",
  "454-19": "csl. PCCW",
  "454-29": "csl. PCCW",
};

/**
 * Where an MCC is, as one entry rather than a name table beside a flag table.
 *
 * Two records keyed by MCC drift the moment one of them gains a row, and this
 * file's whole opening comment is about a drift that is already silent. One
 * entry per MCC is the shape that cannot.
 *
 * `code` is the ISO 3166-1 alpha-2 the flag is built from, and it is optional:
 * an entry whose flag would not match the name it is listed under is better
 * with no flag than with a wrong one, and the name still renders either way.
 */
const TERRITORIES: Record<string, { name: string; code?: string }> = {
  "310": { name: "美国", code: "US" },
  "311": { name: "美国", code: "US" },
  "460": { name: "中国大陆", code: "CN" },
  "454": { name: "中国香港", code: "HK" },
  "455": { name: "中国澳门", code: "MO" },
  "466": { name: "中国台湾" },
  // Present in edge-core/src/network.rs and missing here until 2026-08-30,
  // which is the drift the opening comment predicted: a card on any of these
  // rendered its operator with no territory beside it and nothing failed.
  "440": { name: "日本", code: "JP" },
  "450": { name: "韩国", code: "KR" },
  "505": { name: "澳大利亚", code: "AU" },
  "525": { name: "新加坡", code: "SG" },
};

/** Regional-indicator pair for an alpha-2 code: "US" -> 🇺🇸. */
function flagOf(code: string): string {
  const BASE = 0x1f1e6; // 🇦
  return String.fromCodePoint(
    ...[...code].map((letter) => BASE + letter.charCodeAt(0) - "A".charCodeAt(0)),
  );
}

/** Operator name for a "460-01" style PLMN, or the pair itself when unknown. */
export function operatorName(plmn: string): string {
  return OPERATORS[plmn] ?? plmn;
}

/** Territory of the MCC, when it is one this product meets. */
export function territoryName(plmn: string): string | null {
  return TERRITORIES[plmn.slice(0, 3)]?.name ?? null;
}

/**
 * Flag for the MCC's territory, or null when there is no flag to show.
 *
 * Null covers two different cases on purpose — an MCC nobody has listed, and a
 * listed one carrying no `code` — because the caller does the same thing for
 * both: render the name without a flag. Distinguishing them would only invite
 * a caller to treat one as an error.
 */
export function territoryFlag(plmn: string): string | null {
  const code = TERRITORIES[plmn.slice(0, 3)]?.code;
  return code ? flagOf(code) : null;
}

/**
 * True when the card is registered outside its home operator's network.
 * Comparing operators rather than raw PLMNs: a 中国移动 card on 460-02
 * instead of 460-00 is not roaming in any sense an operator cares about.
 */
export function isRoaming(home: string, serving: string): boolean {
  return operatorName(home) !== operatorName(serving);
}
