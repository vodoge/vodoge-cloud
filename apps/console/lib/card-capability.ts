/**
 * The operations a card's plan can be declared to include or exclude.
 *
 * Deliberately not in `lib/tokens.ts`. That file is a Tailwind content glob,
 * so every string literal in it is scanned as a possible class name — and
 * `"data"`, `"voice"`, `"smsSend"` and `"smsReceive"` were duly reported as
 * classes that produce no CSS. The same trap has caught this repo before with
 * ordinary English words in prose; a list of field names is the same shape of
 * mistake, so the list lives outside the glob instead.
 */
export const CARD_CAPABILITY_OPERATIONS = ["smsSend", "smsReceive", "data", "voice"] as const;

export type CardCapabilityOperation = (typeof CARD_CAPABILITY_OPERATIONS)[number];

/** The message key naming one operation in the operator's language. */
export function cardCapabilityLabelKey(operation: CardCapabilityOperation): string {
  switch (operation) {
    case "smsSend":
      return "cards.capabilitySmsSend";
    case "smsReceive":
      return "cards.capabilitySmsReceive";
    case "data":
      return "cards.capabilityData";
    case "voice":
      return "cards.capabilityVoice";
  }
}
