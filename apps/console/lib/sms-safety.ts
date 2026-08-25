/**
 * What the inbox refuses to do, and why.
 *
 * Everything here used to live in `lib/tokens.ts` with a note on it saying it
 * did not belong there. It was put in the design system because the card that
 * wrote it (T014) could edit exactly one file under `lib/`, and a `.tsx` in this
 * app cannot be unit tested — so the alternative was not a better home, it was
 * no test at all.
 *
 * There is a second reason to move it, and it is the stronger one.
 * `lib/tokens.ts` is a Tailwind *content* file: the scanner reads its text, not
 * its meaning, and a word in a comment that happens to be a utility name becomes
 * a rule in the stylesheet the console downloads. This file is not content, so
 * the prose below — which is long, because the wording is the safety property —
 * cannot leak into the build.
 *
 * Three things live here:
 *
 * 1. `CONFIRMED_WRITES` — the ledger of writes that may only run after somebody
 *    answered a question.
 * 2. `SMS_BLOCKED_MODULES` — the module this console will not send from, and
 *    what that costs, which is not what it looks like.
 * 3. `sendHold` — the single answer to "may this form send right now", which is
 *    fail-closed on purpose. See below.
 */

/**
 * Writes that may only happen after somebody answered the question.
 *
 * Keyed by file, valued by the function that performs the request. The check in
 * `tokens.test.ts` is deliberately about **where the call site is**, not about
 * whether a dialog exists somewhere in the file: each name here has to perform
 * a mutating `fetch`, has to be reachable from a `ConfirmDialog`'s `onConfirm`,
 * and must **not** be named in any `onClick` or `onSubmit`.
 *
 * That last clause is the whole point. A file can keep its dialog, keep its
 * confirmation copy, and have somebody wire the button straight back to the
 * function during a later change; every other guard in this repository stays
 * green through that, because the dialog is still *defined*. This board has
 * already been bitten once by an assertion that matched a definition rather
 * than a use (T004), so the rule here is the use.
 *
 * Only the inbox is listed. The other dangerous actions T030 found live in
 * files no card has owned yet, and a name added here for a function that does
 * not exist yet is a failing test rather than a reminder — which is the right
 * way round: the card that writes the confirmation adds the line.
 */
export const CONFIRMED_WRITES = {
  "components/card-policies.tsx": ["save", "removePolicy"],
  "components/send-sms.tsx": ["sendMessage"],
  "components/conversation.tsx": ["removeThread", "removeMessage", "forgetContact"],
} as const;

/* ── Modules this console will not send a message from ───────────────────
 *
 * Not a policy invented here, and — this is the part that keeps being got
 * wrong — **not "SMS is broken on that stick"**.
 *
 * `867018069509705` stalls its own QMI interrupt endpoint on every MO submit:
 * the USB/IP session is torn down and the module leaves the bus for tens of
 * seconds. Both transports trigger it, and a full `AT+CFUN=1,1` does not clear
 * it. `edge-bin/src/main.rs:537-560` is the primary record, and it says the
 * opposite of what this board believed until T006 checked:
 *
 * > The submit itself is not undone by that -- the SIM's own MO reference
 * > counter in `EF_SMSS` advanced by 34 over a day of sends the console
 * > recorded as failures, and 10086 kept replying to them. Told "failed", an
 * > operator resends and the recipient gets it twice.
 *
 * So the cost is not a lost message. It is a lost module, and the copy in
 * `messages/*.json` has to say that: telling an operator the message cannot be
 * sent is the exact lie that daemon comment exists to stop, and it produces
 * duplicate messages at the far end.
 *
 * ⚠️ **Keyed by IMEI, and matched against a whole device.** The console's send
 * takes a `device_id` and no module, so which module carries the message is
 * decided at the edge — and with nothing to aim it, the edge takes the first
 * entry out of its modem map. A device holding one of these is therefore a
 * device this console cannot promise anything about, which is why the whole
 * device is refused rather than one option in a picker this form does not have.
 */

/** IMEI → the message keys that say why, and what the cost really is. */
export const SMS_BLOCKED_MODULES = {
  "867018069509705": {
    why: "inbox.smsBlockedWhy",
    /** The correction: the message usually goes out. Never say it failed. */
    cost: "inbox.smsBlockedCost",
  },
} as const;

export type SmsBlockedModule = { readonly imei: string; readonly why: string; readonly cost: string };

/**
 * The modules on `deviceId` that this console will not send from.
 *
 * Empty means "nothing known against it", which is not the same as "checked".
 * A caller that could not read the module list has to say so itself — an empty
 * array here and an empty array from a failed read are the same value, and this
 * console has already shipped that bug once on `/audit`. `sendHold` below is
 * where the two are told apart.
 */
export function blockedSendModules(
  modems: readonly { readonly deviceId: string; readonly imei: string }[],
  deviceId: string,
): SmsBlockedModule[] {
  const table = SMS_BLOCKED_MODULES as Record<string, { why: string; cost: string }>;
  const out: SmsBlockedModule[] = [];
  for (const modem of modems) {
    if (modem.deviceId !== deviceId) continue;
    const entry = table[modem.imei];
    if (entry) out.push({ imei: modem.imei, why: entry.why, cost: entry.cost });
  }
  return out;
}

/**
 * Why the send form is not sending, or `null` when it may.
 *
 * - `blocked-module` — the chosen device carries a module that must not send.
 * - `modules-unknown` — `GET /v1/modems` could not be read, so *whether* it
 *   does is unknown.
 */
export type SendHold = "blocked-module" | "modules-unknown" | null;

/**
 * 🔴 **`modules-unknown` holds the send. This is a decision, and it reverses
 * what shipped before.**
 *
 * Until now a failed module read left the form saying it could not check and
 * left the button live. That was defended as "a gateway wobble should not
 * switch off the fleet's messaging", and it is a real cost — an operator who
 * cannot send will retry, and retrying is free.
 *
 * It was still the wrong way round, and the operator ruled it closed on
 * 2026-08-25. The whole reason the module list is read at all is to stop one
 * particular send from taking a module off the USB bus, on hardware nobody can
 * walk over to and re-seat. "We could not find out which modules are banned, so
 * go ahead" is *not knowing* being used as permission for the dangerous half of
 * the choice. The edge panel had the same defect on the same module and it was
 * fixed the same way: when the answer is unknown, do not draw the optimistic
 * one.
 *
 * ⚠️ The copy that goes with this must say **the module list could not be
 * read**, never "the send failed". They are different events with different
 * responses: a failure invites a resend, and a resend is the thing that costs a
 * module. `sms-safety.test.ts` holds `inbox.smsModemsUnknown` to that in both
 * languages.
 *
 * A note on the argument order: `blocked-module` wins when both apply, because
 * it is the more specific answer and it names the module. In practice the two
 * cannot co-occur — with no module list there is nothing to match against —
 * but a caller that passes a stale list with a fresh failure should still get
 * the sentence with the IMEI in it.
 */
export function sendHold(options: {
  /** `false` when `GET /v1/modems` did not answer. Not "the list was empty". */
  readonly modemsKnown: boolean;
  readonly blocked: readonly SmsBlockedModule[];
}): SendHold {
  if (options.blocked.length > 0) return "blocked-module";
  if (!options.modemsKnown) return "modules-unknown";
  return null;
}

/**
 * Writes a file makes that are deliberately *not* behind a confirmation.
 *
 * PM merge note (T009 + T032). T009's guard asserts that every mutating request
 * in a listed file sits inside a function named in `CONFIRMED_WRITES`, and it
 * is right to: without that, a second `fetch` written straight into a handler
 * passes every other line of the check. T032 dropped the assertion instead of
 * reconciling it, which is a weakening, so it is back — with this list beside
 * it.
 *
 * Being on this list is not an exemption from thinking. It says the write is
 * real, somebody looked at it, and a dialog is the wrong instrument: marking a
 * thread read is not an action the operator took, and renaming a contact is
 * undone by renaming it again. Both are still refused for a read-only account.
 *
 * The count is what makes it a guard rather than a comment: a sixth write in
 * `conversation.tsx` fails this file's test until somebody writes down which
 * kind it is.
 */
export const WRITES_WITHOUT_A_DIALOG: Readonly<Record<string, { count: number; why: string }>> = {
  "components/conversation.tsx": {
    count: 2,
    why:
      "POST /v1/messages/thread/read fires from an effect, not from a control — " +
      "there is no moment to ask about. PUT /v1/messages/contact renames a " +
      "contact, which the next rename undoes. Both sit behind the role gate.",
  },
};
