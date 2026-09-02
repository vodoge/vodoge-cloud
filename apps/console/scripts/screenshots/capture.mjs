/**
 * 重拍 PWA 安装截图。
 *
 * 这两张图会出现在浏览器的安装弹窗里，也就是说它们是**给用户看的产物**，而
 * `lib/pwa.test.ts` 和 `lib/palette-drift.test.ts` 有一整族守卫盯着它们和这棵树
 * 是否一致。界面一变就得重拍，而重拍不是随手截个图——下面每一条都是拍错过一次
 * 之后写下来的。
 *
 * ## 怎么跑
 *
 *   1. 装浏览器（只需一次）。国内直连 Playwright 的 CDN 会超时，用镜像：
 *
 *        PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright \
 *          npx --yes playwright@latest install chromium
 *
 *   2. 构建，并把静态资源放到 standalone 产物里：
 *
 *        npm run build
 *        rm -rf .next/standalone/.next/static .next/standalone/public
 *        mkdir -p .next/standalone/.next/static .next/standalone/public
 *        cp -r .next/static/. .next/standalone/.next/static/
 *        cp -r public/.      .next/standalone/public/
 *
 *      ⚠️ 结尾的 `/.` 不能省。`cp -r a b` 在 `b` 已存在时会生成 `b/a`，于是悄悄
 *      多出一层 `static/static`，页面不报错但不上 CSS —— `docs/execution-plan.md`
 *      为控制台部署记过同一个坑。**而且必须拷完再启动服务**：先启动的话它会带着
 *      「那时没有静态目录」的状态一直 404。
 *
 *   3. 两个进程：
 *
 *        node scripts/screenshots/stub-gateway.mjs
 *        (cd .next/standalone && VODOGE_GATEWAY_URL=http://127.0.0.1:8788 \
 *           PORT=3000 HOSTNAME=127.0.0.1 node server.js)
 *
 *   4. 拍：
 *
 *        node scripts/screenshots/capture.mjs
 *
 *   5. `npm test`。守卫会要求更新 `CAPTURED_FROM` 里的两个 sha256 和 `chrome`
 *      摘要——它们会把新值直接印在失败信息里。
 *
 * ## 两条必须照做的，各自都是被守卫抓回来过的
 *
 * 🔴 **`--disable-lcd-text`。** Chromium 默认次像素抗锯齿，字缘的 R/G/B 按不同
 * 比例插值，会产生像 `#090919` 这种单通道抬高的颜色；而
 * `lib/pwa.test.ts` 的「退休的颜色藏不住」那条用的抗锯齿模型是三通道共用一个
 * 比例的灰度混合，解释不了它们。第一次拍完就是被这条打回来的。**修拍摄方式，
 * 不要去放宽守卫的容差。**
 *
 * 🔴 **`clip` 从 y=0 开始。** 「每张截图都从文档顶部开始」那条守卫比对的是前几
 * 十行里首次出现前景色、边框色和第一行非均匀像素的行号。滚动过再拍会整体位移，
 * 而画面尺寸和配色都还是对的——那是最难看出来的一种错。
 *
 * ## 尺寸从哪来
 *
 * 不写死：从 `lib/pwa.ts` 的 manifest 声明里读。两处各写一遍就是两处会分家，而
 * 分家之后浏览器会按 manifest 说的尺寸去缩放一张实际不是那个尺寸的图。
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

import { consoleManifest } from "../../lib/pwa.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ORIGIN = "http://127.0.0.1:8788";

/** manifest 说 780x1688，那是 390x844 拍 2 倍。 */
function viewportFor(shot) {
  const [width, height] = shot.sizes.split("x").map(Number);
  const scale = shot.form_factor === "narrow" ? 2 : 1;
  return { width: width / scale, height: height / scale, scale };
}

const browser = await chromium.launch({
  args: [
    // 见上：灰度抗锯齿，否则守卫解释不了字缘的颜色。
    "--disable-lcd-text",
    "--disable-font-subpixel-positioning",
    "--force-color-profile=srgb",
  ],
});

for (const shot of consoleManifest().screenshots) {
  const { width, height, scale } = viewportFor(shot);
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: scale,
    // 守卫比对的是暗色调色板，因为暗色是没有脚本跑过时真正画出来的那一套。
    colorScheme: "dark",
    locale: "zh-CN",
  });
  const page = await context.newPage();
  await page.goto(ORIGIN + "/", { waitUntil: "networkidle" });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(600);

  const file = join(root, "public", shot.src.slice(1));
  mkdirSync(dirname(file), { recursive: true });
  await page.screenshot({ path: file, clip: { x: 0, y: 0, width, height } });
  console.log(`  ${shot.src}  ${shot.sizes}  (${width}x${height} @${scale}x)`);
  await context.close();
}

await browser.close();
console.log("\n下一步：npm test —— 守卫会把新的 sha256 和 chrome 摘要印在失败信息里。");
