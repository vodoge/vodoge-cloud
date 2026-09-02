import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/cn"
import { toneForState } from "@/lib/tokens"

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-transparent bg-primary text-primary-foreground shadow hover:bg-primary/80",
        secondary:
          "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive:
          "border-transparent bg-destructive text-destructive-foreground shadow hover:bg-destructive/80",
        outline: "text-foreground",
      },
      /**
       * 状态色。这是**产品语义**，不是主题——在线 / 告警 / 故障 / 提示，
       * shadcn 只有 destructive 一档，没有对应物，所以这几档保留。
       *
       * 底色用 wash 而不是实心：这些徽章成排出现在表格里，实心块会让整张表
       * 变成色带，而它们要标的是**个别行的异常**。
       */
      tone: {
        ok: "border-transparent bg-ok-wash text-ok",
        warn: "border-transparent bg-warn-wash text-warn",
        bad: "border-transparent bg-bad-wash text-bad",
        info: "border-transparent bg-info-wash text-info",
        neutral: "border-transparent bg-border text-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {
  /**
   * 关掉它，给不是状态的标签用——一个计数、一个分类。
   *
   * 🔴 这个点是**真实元素**而不是 ::before，理由是无障碍：它让色调同时以
   * **形状**呈现，而形状是单色屏和色觉障碍能拿到的东西。shadcn 的 Badge
   * 没有这个，是这里刻意加回去的。
   */
  dot?: boolean
}

function Badge({ className, variant, tone, dot = true, children, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant: tone ? undefined : variant, tone }), className)} {...props}>
      {tone && dot ? (
        <span className="mr-1 size-1.5 shrink-0 rounded-full bg-current" aria-hidden="true" />
      ) : null}
      {children}
    </div>
  )
}

/**
 * 一个色调由状态词本身决定的徽章。
 *
 * 存在的理由是让「哪个词算好、哪个算坏」只有一处答案：调用方给状态词，
 * 不给颜色。散落各处的 `tone={x === "online" ? "ok" : "bad"}` 迟早会在某一处
 * 写反，而写反的那一处正是没人盯着的那一处。
 */
export function StateBadge({
  state,
  label,
  ...props
}: Omit<BadgeProps, "tone" | "children"> & { state: string; label?: string }) {
  return (
    <Badge tone={toneForState(state)} {...props}>
      {label ?? state}
    </Badge>
  )
}

export { Badge, badgeVariants }
