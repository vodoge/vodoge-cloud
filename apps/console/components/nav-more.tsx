"use client";

import Link from "next/link";
import { useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { cn } from "@/lib/cn";

/**
 * 底部导航里放不下的那些目的地。
 *
 * 之前是 `<details>` + `<summary>`，整个导航因此是服务端组件。换成 Radix 的
 * Sheet 换来的是现成的进出场动画、焦点陷阱、Escape、滚动锁和 aria 角色——都
 * 不必手写。
 *
 * 🔴 **语言仍然由服务端解析。** 条目和文案是 props，这个组件一个字都不翻译。
 * 原来的注释解释过为什么：在水合之后才读 locale 的导航，会让 HTML 里对所有人
 * 都是默认语言。把客户端边界收到这一个组件里，而不是让它爬到整棵导航树上。
 *
 * 失去的是「JS 关闭时也能展开」。对一个浏览器里用的监控台这不是真约束——这个
 * app 别处本来就有客户端组件——但它确实是一项被换掉的性质，写在这里而不是
 * 悄悄消失。
 */
export type NavMoreItem = {
  href: string;
  icon: string;
  label: string;
  current: boolean;
};

export function NavMore({
  items,
  triggerLabel,
  title,
}: {
  items: NavMoreItem[];
  triggerLabel: string;
  title: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      {/* `aria-haspopup` 说明这是「打开某物」而不是「去某处」。触发器保持不动，
          动的是被打开的面板。 */}
      <SheetTrigger
        className="flex min-h-touch w-full cursor-pointer list-none flex-col items-center justify-center gap-1 px-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        aria-haspopup="menu"
      >
        <NavIcon d={MORE_ICON} />
        <span className="max-w-full truncate">{triggerLabel}</span>
      </SheetTrigger>
      <SheetContent side="bottom" className="rounded-t-lg">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
        </SheetHeader>
        <div className="mt-2 grid gap-1">
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              aria-current={item.current ? "page" : undefined}
              // 点了就关：Sheet 不知道路由变了，不关的话它会盖在刚打开的页面上。
              onClick={() => setOpen(false)}
              className={cn(
                "flex min-h-touch items-center gap-3 rounded px-3 text-sm text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground",
                item.current ? "bg-brand-wash font-semibold text-foreground" : undefined,
              )}
            >
              <NavIcon d={item.icon} />
              {item.label}
            </Link>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}

const MORE_ICON = "M4 12h16M4 6h16M4 18h16";

function NavIcon({ d }: { d: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-5 shrink-0"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}
