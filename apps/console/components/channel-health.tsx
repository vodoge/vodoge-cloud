import { Badge } from "@/components/ui/badge";
import { SpecRow, SpecTable, TableBody } from "@/components/ui/table";
import type { ChannelHealthRow } from "@/lib/catalog";

type Labels = Record<string, string>;

/**
 * 每条通知渠道最近投递成没成。
 *
 * 🔴 存在的理由是生产上量到的一件事：webhook **连续失败 40 次**（40/40，而
 *    pushplus 和 telegram 各 40 次全成功），而这一页上那条渠道只显示「已启用」。
 *    失败原因每一次都一样 —— `dial tcp: lookup hooktest`，配的是一个解析不了的
 *    占位主机。
 *
 *    `app.notification_attempts` 早把每一次都记下来了，但它在这之前**只有写入
 *    者、没有任何读者**。痕迹有了，没人看。这个组件是那个读者。
 *
 * ⚠️ 放在表单**之前**：运维打开这一页大多是来改配置的，而「你配的东西有一条
 *    从来没成功过」应当在他开始改之前就看见，不是翻到最后才看见。
 */
export function ChannelHealth({
  rows,
  labels,
}: {
  rows: ChannelHealthRow[];
  labels: Labels;
}) {
  // 🔴 一条记录都没有 ≠ 一切正常。网关在读不到记录时根本不放那个字段，所以
  //    空数组的意思是「没有投递记录可看」—— 可能是还没发过，也可能是这张表
  //    读不到。画成一片绿色正是这个组件要避免的那种谎。
  if (rows.length === 0) {
    return <p className="m-0 text-sm text-muted-foreground">{labels.noAttempts}</p>;
  }

  return (
    <SpecTable>
      <TableBody>
        {rows.map((row) => (
          <SpecRow key={row.channel} term={row.channel}>
            <span className="flex flex-wrap items-center gap-2">
              {row.consecutiveFailures === 0 ? (
                <Badge tone="ok">{labels.delivering}</Badge>
              ) : (
                <Badge tone="bad">
                  {labels.failing.replace("{count}", String(row.consecutiveFailures))}
                </Badge>
              )}

              {/* 🔴 「从来没成功过」单独说，不要和「上次成功于 …」混在一起。
                  生产上 webhook 正是前者，而那是一条配置从没通过的证据 ——
                  比「上次成功很久以前」严重得多，两者的修法也不同。 */}
              <span className="text-xs text-muted-foreground">
                {row.lastSuccess === null
                  ? // 🔴 窗口满了 = 更早的记录看不到，所以说不出「从来没成功过」。
                    //    一条曾经一直成功、后来连续失败 51 次的渠道正是这个状态，
                    //    而它和真的从没通过下一步完全不同：一个是刚刚坏掉，一个是
                    //    配置从没对过。缺席 ≠ 空。
                    row.windowFull
                    ? labels.noSuccessInWindow
                    : labels.neverSucceeded
                  : labels.lastSuccess.replace(
                      "{at}",
                      new Date(row.lastSuccess).toISOString().replace("T", " ").slice(0, 16),
                    )}
                {" · "}
                {labels.attempts.replace("{count}", String(row.total))}
              </span>

              {/* 失败原文原样显示。`dial tcp: lookup hooktest` 这一句直接说明是
                  配置写错了；压成「投递失败」就得有人再去翻库。 */}
              {row.lastDetail ? (
                <code className="break-all font-mono text-xs text-destructive">
                  {row.lastDetail}
                </code>
              ) : null}
            </span>
          </SpecRow>
        ))}
      </TableBody>
    </SpecTable>
  );
}
