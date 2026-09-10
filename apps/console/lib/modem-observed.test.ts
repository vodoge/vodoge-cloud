import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

// 没被观测过的那一根，不许画成一排横杠。
//
// 🔴 用户当初那句「数据库里是唯一依据」在云端不成立，就是因为手工纳管的模组
//    在界面上**根本不出现**。让它出现之后，紧接着的错答案是让它出现得像一根
//    坏模组：八个观测格全空，而空在这张表里的常规含义是「读过，没读到」。
//    运维会去拔插一根还没插上的卡。
//
//    所以这里钉住两件事：渲染确实分了岔；没被观测的那一岔给出的是一句话，
//    不是占位横杠。
test("没见过的模组，说的是一句话，不是八个横杠", () => {
  const page = codeOnly(read("app/devices/[deviceId]/page.tsx"));

  assert.match(
    page,
    /\{modem\.observed \?/,
    "模组表没有按 observed 分岔 —— 那没被观测过的那一根就和坏模组长得一样",
  );

  const branch = /\{modem\.observed \?[\s\S]*?\n\s*\)\}/.exec(page);
  assert.ok(branch, "找不到 observed 的分岔");
  const negative = branch[0].slice(branch[0].indexOf(") : ("));
  assert.ok(
    negative.includes("neverSeenHint"),
    "没被观测的那一岔没有给出解释文案：运维只会看到一行空格子",
  );
  assert.ok(
    !negative.includes('"—"'),
    "没被观测的那一岔仍在画占位横杠 —— 横杠的意思是「读过，没读到」，" +
      "而这一根是「还没插上」，两者该做的事正好相反",
  );
});
