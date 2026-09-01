"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { CONFIRM, assertConsequence } from "@/lib/tokens";

/**
 * A confirmation that has somewhere to put the consequence.
 *
 * ## Why this replaces `window.confirm`
 *
 * Every confirmation in this console is `window.confirm(oneString)`, and one
 * string is why `device.confirmDisruptive` — "This takes the module off the
 * network. Continue?" — is shared by seven different commands and names none
 * of them. One of those seven is `restart_modem`, which can leave a module in
 * `+CFUN: 7`, and the operator cannot walk over and unplug it. The two
 * confirmations in this console that *do* state a consequence
 * (`device.confirmUsbnet`, `esim.dlWarn`) had to smuggle it into the question,
 * and both are long paragraphs inside a native dialog as a result.
 *
 * ## Why `consequence` is required, and checked
 *
 * A prop that may be omitted is a prop that gets omitted, and the seven
 * confirmations that have to be written next are being written by a different
 * card than this one. So:
 *
 * - the type has no `?`, which is the compiler refusing an omission;
 * - `assertConsequence` throws on the ones a type cannot catch — empty, a
 *   question with nothing behind it, a fragment too short to name what is
 *   about to happen;
 * - `tokens.test.ts` runs the same rule over every consequence key in the
 *   message catalogues, in both languages, so a consequence written in Chinese
 *   and skipped in English fails the build rather than the operator.
 *
 * Throwing while rendering is deliberate and is the right way round here. A
 * dialog that crashes gets fixed in the first minute; a dialog that asks
 * "Continue?" over a command that strands hardware gets clicked for a year.
 *
 * The dialog asks the question itself, from the shared catalogue — which is
 * also what lets the check reject a consequence that turns out to be another
 * question.
 *
 * Class strings live in `lib/tokens.ts`. See the note in `button.tsx`.
 */

export type ConfirmLabels = {
  question: string;
  proceed: string;
  cancel: string;
};

/**
 * 确认对话框，内部换成 Radix 的 AlertDialog。
 *
 * props 一个都没变，11 处调用和盯着它的四条安全测试都不用动。变的是实现：
 * 焦点陷阱、Escape、滚动锁、aria 角色、以及**打开时焦点落在取消上**，全部由
 * Radix 提供，不再是这里手写的两个 useEffect。
 *
 * 🔴 焦点落在取消上是这个组件存在的理由之一，原注释说得很清楚：以危险按钮
 * 获得焦点的方式打开对话框，**一次误按回车就等于执行了那条命令**。Radix 的
 * AlertDialog 默认把焦点给 Cancel，所以这个属性是被换过来的实现保住的，不是
 * 碰巧还在。
 *
 * `assertConsequence` 保留。它拦的是「弹了个框却没说会发生什么」，那是内容
 * 问题，换任何组件都解决不了。
 */
export function ConfirmDialog({
  open,
  title,
  consequence,
  labels,
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
  className,
}: {
  open: boolean;
  title: string;
  consequence: string;
  labels: ConfirmLabels;
  confirmLabel?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  className?: string;
}) {
  assertConsequence(consequence);
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // Radix 在按 Escape 和点遮罩时都走这里。两者都是「取消」，和原来手写的
        // Escape 监听同义。
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent className={cn(CONFIRM.panel, className)}>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{consequence}</AlertDialogDescription>
        </AlertDialogHeader>
        <p className={CONFIRM.question}>{labels.question}</p>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{labels.cancel}</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: "risk" })}
            disabled={busy}
            onClick={onConfirm}
          >
            {confirmLabel ?? labels.proceed}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
