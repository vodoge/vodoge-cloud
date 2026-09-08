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

// 收件箱的发送表单必须带上网关要求的每一个字段。
//
// 🔴 这条守卫是被一次真实的静默漂移逼出来的。send-sms.tsx 的请求体长期只有
//    {device_id, to, body}，而网关的 send_sms 是 NeedsModem —— BuildPayload
//    在 catalogue.go 里先查 15 位 IMEI，不过就 400「modem_imei must be 15
//    digits」。**收件箱这个表单因此一条都发不出去**，而设备页和计划任务那两条
//    路一直带着它，所以「发短信」整体看起来是好的。
//
//    最能说明问题的是留在原地的两句化石注释：send-sms.tsx 里写着「Exactly the
//    body POST /v1/commands took before, unchanged」，inbox/page.tsx 里写着
//    「/v1/commands takes a device_id and no module」。两句在写下的那天都是对的。
//
// 这条守卫刻意去**读网关的声明**而不是写死一个字段名单：send_sms 哪天不再需要
// 模组，前提会自己跟着变；而只要它还需要，表单就必须问。
test("网关说 send_sms 需要模组，收件箱的表单就必须问", () => {
  const catalogue = read("internal/commands/catalogue.go", gateway);

  const spec = /Kind:\s*"send_sms",[^\n]*\n?[^\n]*/.exec(catalogue);
  assert.ok(spec, "catalogue.go 里找不到 send_sms 的 spec —— 守卫的前提没了");
  const needsModem = /NeedsModem:\s*true/.test(spec[0]);

  const form = codeOnly(read("components/send-sms.tsx"));
  const bodies = form.match(/JSON\.stringify\(\{[\s\S]*?\}\)/g) ?? [];
  assert.ok(bodies.length > 0, "send-sms.tsx 里找不到任何请求体");

  const sends = bodies.filter((body) => body.includes("device_id"));
  assert.ok(sends.length > 0, "send-sms.tsx 的请求体里没有 device_id");

  for (const body of sends) {
    if (needsModem) {
      assert.ok(
        body.includes("modem_imei"),
        "网关的 send_sms 是 NeedsModem，而收件箱的表单没有送 modem_imei —— " +
          "这条请求会被 400 拒掉，页面上只会看到一句红字。" +
          "替运维随便挑一根也不行：收件人看到的是那张卡的号码，费用记在那个订阅上。",
      );
    }
  }
});

// 表单必须真的把模组问出来，而不是塞一个写死的值。
//
// ⚠️ 上一条只看请求体里有没有 modem_imei 这几个字。光有那几个字，写死一个
//    常量、或者 `modems[0].imei` 都能满足它 —— 而「替运维挑一根」正是这次
//    改动要避免的那个错答案。所以这里另外钉住：表单里有一个名为 modem_imei
//    的输入控件，它的值来自用户选择。
test("模组是被问出来的，不是替运维挑的", () => {
  const form = codeOnly(read("components/send-sms.tsx"));

  assert.match(
    form,
    /name="modem_imei"/,
    "表单里没有名为 modem_imei 的控件：那意味着这个值是代码替运维定的",
  );
  assert.match(
    form,
    /onChange=\{\(event\) => setModemImei\(event\.target\.value\)\}/,
    "modem_imei 控件没有把选择写回 state —— 那它就不是一个真的选择",
  );
});
