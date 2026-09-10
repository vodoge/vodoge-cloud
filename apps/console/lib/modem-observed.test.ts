import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const gateway = join(root, "..", "gateway");

function read(relative: string, base = root): string {
  return readFileSync(join(base, relative), "utf8");
}

/** 去掉注释，免得守卫被一段解释自己的文字满足。 */
function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

// 「见过没有」这个字段，网关叫什么控制台就得读什么。
//
// ⚠️ 这是一次跨语言的静默漂移：网关那边是一个 Go 结构体标签，控制台这边是一次
//    属性读取，中间没有任何类型检查。名字对不上时 `row.observed` 求值为
//    undefined，而 parseModem 的默认值是**真**（老网关不发这个字段时要保持旧行为），
//    于是每一根手工纳管、还没到货的模组都会被画成一根观测数据全空的模组 ——
//    也就是「模组坏了」的样子。红都不会红一下。
test("网关怎么起名，控制台就怎么读", () => {
  const source = read("internal/catalog/catalog.go", gateway);

  const field = /Observed\s+bool\s+`json:"([^"]+)"`/.exec(source);
  assert.ok(field, "catalog.go 里找不到 Observed 的 json 标签 —— 守卫的前提没了");
  const key = field[1];

  const parser = codeOnly(read("lib/catalog.ts"));
  assert.match(
    parser,
    new RegExp(`row\\.${key}\\b`),
    `网关送的是 "${key}"，而 parseModem 没有读这个键`,
  );
});

// 每一个吃这份数据的页面，都必须处理「从没被观测过」这一种。
//
// 🔴 这条守卫的第一版**只读 `app/devices/[deviceId]/page.tsx`**，而那正好是
//    唯一改对了的那个文件。同一份 `/v1/modems` 有三个消费方（网关那个查询是
//    整租户的，不是按设备的）：设备详情页、设备总览页、收件箱的发送表单。
//    改动把「纳管了但从没见过」的行放进了这份数据，却只有一个页面跟着改 ——
//    另外两个把它画成了「模组坏了」和「可以选中的发送方」。
//
//    一条写死单个路径的守卫，范围本身就是那个洞的藏身处。所以这里**从代码里
//    数出消费方**：谁 import 了 fetchModems，谁就得处理这一种。将来多一个页面
//    忘了处理，这条断言会自己变红。
//
// ⚠️ 「处理了」的判据不是出现过 `observed` 这几个字，而是**分了岔**：
//    读一下这个字段却照旧画横杠，正是这次要修的那个错。
test("每一个读模组列表的页面都得给「从没见过」留位置", () => {
  const pages = readdirSync(join(root, "app"), { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith("page.tsx"))
    .filter((name) => read(join("app", name)).includes("fetchModems"));

  assert.ok(
    pages.length >= 3,
    `只找到 ${pages.length} 个消费方（${pages.join(", ")}）—— ` +
      "预期至少三个：设备详情、设备总览、收件箱。少于三个说明这条守卫的前提变了，" +
      "先确认是页面删了还是数错了，别直接把数字调小。",
  );

  for (const name of pages) {
    const page = codeOnly(read(join("app", name)));
    assert.match(
      page,
      /modem\.observed/,
      `${name} 读了模组列表，却完全没看 observed —— ` +
        "从没被观测过的那一根在它那里会被画成一根观测数据全空的模组，也就是「坏模组」的样子",
    );
    // 「处理了」= 自己据它分岔，或者把它交给一个会分岔的组件。
    //
    // ⚠️ 只认「自己分岔」是不够的：收件箱那个页面是纯转交的，真正据它决定
    //    选不选得中的是 components/send-sms.tsx。而只认「提到过 observed」
    //    又太松 —— 读一眼却照旧画横杠正是这次要修的错。所以两条都查，
    //    并且转交那一支要**真的去读那个组件的源码**。
    const branches = (source: string) =>
      /\{modem\.observed \?|modem\.observed === false \?|!modem\.observed|modem\.observed\)/.test(
        source,
      );

    let handled = branches(page);
    if (!handled) {
      for (const [, spec] of page.matchAll(/from "@\/components\/([\w-]+)"/g)) {
        let child: string;
        try {
          child = codeOnly(read(join("components", `${spec}.tsx`)));
        } catch {
          continue;
        }
        if (branches(child)) {
          handled = true;
          break;
        }
      }
    }
    assert.ok(
      handled,
      `${name} 提到了 observed，但既没有据它分岔，也没有把它交给任何一个会分岔的组件 —— ` +
        "读一眼却照旧画横杠，正是这次要修的那个错",
    );
  }
});

// 没被观测过的那一根，不许画成一排横杠。
//
// 🔴 用户当初那句「数据库里是唯一依据」在云端不成立，就是因为手工纳管的模组
//    在界面上**根本不出现**。让它出现之后，紧接着的错答案是让它出现得像一根
//    坏模组：观测格全空，而空在这些表里的常规含义是「读过，没读到」。
//    运维会去拔插一根还没插上的卡。
//
//    所以这里钉住两件事：渲染确实分了岔；没被观测的那一岔给出的是一句话，
//    不是占位横杠。两个表格都要过这一关。
test("没见过的模组，说的是一句话，不是一排横杠", () => {
  for (const relative of ["app/devices/[deviceId]/page.tsx", "app/devices/page.tsx"]) {
    const page = codeOnly(read(relative));

    assert.match(
      page,
      /\{modem\.observed \?/,
      `${relative} 的模组表没有按 observed 分岔 —— 那没被观测过的那一根就和坏模组长得一样`,
    );

    const branch = /\{modem\.observed \?[\s\S]*?\n\s*\)\}/.exec(page);
    assert.ok(branch, `${relative} 里找不到 observed 的分岔`);
    const negative = branch[0].slice(branch[0].indexOf(") : ("));
    assert.ok(
      negative.includes("neverSeenHint"),
      `${relative}：没被观测的那一岔没有给出解释文案，运维只会看到一行空格子`,
    );
    assert.ok(
      !negative.includes('"—"'),
      `${relative}：没被观测的那一岔仍在画占位横杠 —— 横杠的意思是「读过，没读到」，` +
        "而这一根是「还没插上」，两者该做的事正好相反",
    );
    // 总览页那张表还会把 `state` 为 null 画成 `unknown` 徽标、把没有
    // last_seen 画成「从未」。前者读起来是「状态不明的模组」，后者读起来是
    // 「曾经上报、现在停了」—— 两句都比横杠更像一个结论，所以都不许留在
    // 这一岔里。
    assert.ok(
      !/\bunknown\b/.test(negative) && !negative.includes("common.never"),
      `${relative}：没被观测的那一岔还在画 unknown 状态或「从未」`,
    );
  }
});

// 发短信的「从哪根发」不能把一根还没到货的模组列成可选发送方。
//
// 🔴 它的 msisdn 和 iccid 都是 NULL，于是网关算出的 msisdnPending 是 false，
//    选项会被画成「这张卡没有号码」—— 一个看起来完全正常、可以选中的发送方，
//    而那根棒子还在备件柜里。发出去必然失败，而且失败在边缘：运维在控制台上
//    看到的是一条已提交的命令。
//
// ⚠️ 不是「过滤掉」就算对。藏起来的话，运维会以为自己纳管的那一根丢了，
//    转头再纳管一遍。要的是：列出来、选不中、写清为什么。
test("还没到货的模组不能成为可选的发信方", () => {
  const form = codeOnly(read("components/send-sms.tsx"));

  assert.match(
    form,
    /const sendable = [^\n]*\.filter\(\(modem\) => modem\.observed\)/,
    "可发列表没有把「没见过的」排除掉：那一根会被选中，然后在边缘上失败",
  );
  assert.match(
    form,
    /<option[^>]*disabled>/,
    "没见过的那几根没有以 disabled 选项的形式留在列表里 —— " +
      "藏起来会让运维以为纳管记录丢了，转头再纳管一遍",
  );
  assert.match(
    form,
    /labels\.neverSeen/,
    "那几个 disabled 选项没有说明为什么选不了",
  );
});
