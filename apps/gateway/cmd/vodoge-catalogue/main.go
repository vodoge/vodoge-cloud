// Command vodoge-catalogue manages the cross-tenant supported-device list —
// 「我们支持哪些硬件」这份名单，纳管闸 1 的第二半就是按它判的。
//
// 为什么是一个 CLI，而不是控制台上的一个页面：这张表**没有 tenant_id**，
// 它是跨租户事实。一个租户管理员不该能改它，否则 A 租户加一款硬件就影响了
// B 租户的机队。写入面的归宿是 admin.vodoge.com，而那个站还没有认证。
// 在它建起来之前，这里是唯一的写入路径 —— 和 publish-ledger 同一个模式：
// 一次运维动作，跑在云主机上，用超级用户身份。
//
// 🔴 这张表的空与非空是两种完全不同的语义，而且切换是单向温和的。
//
//	空表   → `ledger.Document` 整个不写 `[[device]]` 键
//	       → 边缘的 DeviceGate 读作 NotStated → **放行一切**
//	非空表 → 写出 `[[device]]` 段
//	       → 不在段里的硬件读作 Absent → **一律拒绝纳管**
//
// 也就是说**加第一条的那一刻，机队的行为就翻了个面**。所以 -add 在把表从
// 空变成非空时会拒绝执行，除非你先看过它列出的「谁会被挡在外面」，并显式
// 带上 -i-know-this-gates-the-fleet。
//
// 用法：
//
//	vodoge-catalogue -list
//	vodoge-catalogue -check                       # 只算不写：现在加会挡掉谁
//	vodoge-catalogue -add -vendor 2c7c -product 0125 -strategy quectel-qmi \
//	                 -note "EC20，2026-09 起在机队上跑" -by yuanshuai
//	vodoge-catalogue -disable -vendor 2c7c -product 0901 -by yuanshuai
//	vodoge-catalogue -enable  -vendor 2c7c -product 0901 -by yuanshuai
package main

import (
	"context"
	"database/sql"
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/ledger"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "vodoge-catalogue: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	var (
		list     = flag.Bool("list", false, "列出目录里的每一条")
		check    = flag.Bool("check", false, "只算不写：现在把表变成非空会挡掉机队上的谁")
		add      = flag.Bool("add", false, "加一款硬件")
		disable  = flag.Bool("disable", false, "停用一款硬件（保留记录，不删行）")
		enable   = flag.Bool("enable", false, "把停用的重新启用")
		vendor   = flag.String("vendor", "", "USB vendor id，四位十六进制小写，例如 2c7c")
		product  = flag.String("product", "", "USB product id，四位十六进制小写，例如 0125")
		strategy = flag.String("strategy", "", "本 build 用哪条策略驱动它，例如 quectel-qmi")
		note     = flag.String("note", "", "为什么加它 —— 事后没有别的地方能回答这个问题")
		by       = flag.String("by", "", "谁加的")
		ack      = flag.Bool("i-know-this-gates-the-fleet", false,
			"确认：把表从空变成非空会让不在表里的硬件一律不能再纳管")
	)
	flag.Parse()

	url := os.Getenv("VODOGE_DATABASE_URL")
	if url == "" {
		return fmt.Errorf("VODOGE_DATABASE_URL is required")
	}
	db, err := sql.Open("pgx", url)
	if err != nil {
		return fmt.Errorf("open: %w", err)
	}
	defer db.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	switch {
	case *list:
		return runList(ctx, db)
	case *check:
		return runCheck(ctx, db, nil)
	case *add:
		return runAdd(ctx, db, *vendor, *product, *strategy, *note, *by, *ack)
	case *disable:
		return runSetEnabled(ctx, db, *vendor, *product, *by, false)
	case *enable:
		return runSetEnabled(ctx, db, *vendor, *product, *by, true)
	default:
		flag.Usage()
		return fmt.Errorf("挑一个动作：-list / -check / -add / -disable / -enable")
	}
}

// fleetDevice 是机队上真实跑着的一款硬件，以及它现在带着几根模组。
type fleetDevice struct {
	vendor  string
	product string
	family  string
	managed int
}

// fleetInventory 读「现在被管着的模组，各自坐在什么 USB 硬件上」。
//
// 这是联锁的依据。它连的是候选表而不是模组表：vid/pid 只有候选行上有
// （模组表记的是 IMEI 和卡，不是硬件型号）。
func fleetInventory(ctx context.Context, db *sql.DB) ([]fleetDevice, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT COALESCE(c.vendor_id, ''),
		       COALESCE(c.product_id, ''),
		       COALESCE(max(m.family), ''),
		       count(*)
		  FROM app.modem_candidates c
		  JOIN app.modems m
		    ON m.tenant_id = c.tenant_id AND m.imei = c.imei AND m.managed
		 GROUP BY 1, 2
		 ORDER BY 1, 2`)
	if err != nil {
		return nil, fmt.Errorf("read fleet: %w", err)
	}
	defer rows.Close()
	var out []fleetDevice
	for rows.Next() {
		var item fleetDevice
		if err := rows.Scan(&item.vendor, &item.product, &item.family, &item.managed); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func runList(ctx context.Context, db *sql.DB) error {
	devices, err := ledger.SQLDevices{DB: db}.ListSupportedDevices(ctx)
	if err != nil {
		return err
	}
	if len(devices) == 0 {
		fmt.Println("目录是空的。")
		fmt.Println()
		fmt.Println("⚠️  空表**不是**「什么都不支持」——它是「不表态」，边缘端一律放行。")
		fmt.Println("   加第一条之前先跑 -check，看它会挡掉谁。")
		return nil
	}
	fmt.Printf("%-6s %-8s %-16s %-6s %s\n", "vid", "pid", "策略", "启用", "备注")
	for _, device := range devices {
		mark := "是"
		if !device.Enabled {
			mark = "否"
		}
		text := ""
		if device.Note != nil {
			text = *device.Note
		}
		fmt.Printf("%-6s %-8s %-16s %-6s %s\n",
			device.UsbVendor, device.UsbProduct, device.Strategy, mark, text)
	}
	return nil
}

// runCheck 回答「现在把这张表变成非空，机队上谁会被挡在外面」。
//
// pending 是准备加进去的那一条（-add 时传，-check 时为 nil）。
func runCheck(ctx context.Context, db *sql.DB, pending *ledger.SupportedDevice) error {
	devices, err := ledger.SQLDevices{DB: db}.ListSupportedDevices(ctx)
	if err != nil {
		return err
	}
	covered := map[string]bool{}
	for _, device := range devices {
		if device.Enabled {
			covered[key(device.UsbVendor, device.UsbProduct)] = true
		}
	}
	if pending != nil {
		covered[key(pending.UsbVendor, pending.UsbProduct)] = true
	}

	fleet, err := fleetInventory(ctx, db)
	if err != nil {
		return err
	}
	if len(fleet) == 0 {
		fmt.Println("机队上现在一根被管着的模组都没有 —— 没有东西会被挡掉。")
		return nil
	}

	orphans := lockedOut(covered, fleet)

	fmt.Println("机队上在管的硬件：")
	for _, device := range fleet {
		mark := "✅ 在目录里"
		if !covered[key(device.vendor, device.product)] {
			mark = "❌ 会被挡掉"
		}
		fmt.Printf("  %s:%s  %-12s %d 根  %s\n",
			device.vendor, device.product, device.family, device.managed, mark)
	}
	if len(orphans) == 0 {
		fmt.Println()
		fmt.Println("没有硬件会被挡掉。")
		return nil
	}

	total := 0
	for _, device := range orphans {
		total += device.managed
	}
	fmt.Println()
	fmt.Printf("⚠️  有 %d 款硬件、共 %d 根在管的模组不在目录里。\n", len(orphans), total)
	fmt.Println()
	fmt.Println("   已经纳管的**不会被立刻踢掉** —— 追溯执行默认只标记不解绑")
	fmt.Println("   （VODOGE_RETRO_ENFORCE）。但它们会被标记、开始走隔离期倒计时，")
	fmt.Println("   而且从此刻起：**这些硬件再也不能被纳管**，拔了重插也不行。")
	return nil
}

func runAdd(ctx context.Context, db *sql.DB, vendor, product, strategy, note, by string, ack bool) error {
	vendor, product = strings.ToLower(strings.TrimSpace(vendor)), strings.ToLower(strings.TrimSpace(product))
	strategy, by = strings.TrimSpace(strategy), strings.TrimSpace(by)
	if err := checkUsbID("vendor", vendor); err != nil {
		return err
	}
	if err := checkUsbID("product", product); err != nil {
		return err
	}
	if strategy == "" {
		return fmt.Errorf("-strategy 是必填的：不写清本 build 用哪条策略驱动它，闸 1 的第一半就没有依据")
	}
	if by == "" {
		return fmt.Errorf("-by 是必填的：事后「这条是谁加的」没有别的地方能回答")
	}

	existing, err := ledger.SQLDevices{DB: db}.ListSupportedDevices(ctx)
	if err != nil {
		return err
	}

	// 🔴 只有从空变成非空这一次需要联锁。表已经非空时，机队的行为早就翻过
	//    面了，再加一条只会让更多硬件被放行 —— 那个方向是安全的。
	if len(existing) == 0 {
		fmt.Println("这是目录里的第一条 —— 它会把整个机队的纳管行为翻过面。")
		fmt.Println()
		pending := ledger.SupportedDevice{UsbVendor: vendor, UsbProduct: product}
		if err := runCheck(ctx, db, &pending); err != nil {
			return err
		}
		if !ack {
			fmt.Println()
			return fmt.Errorf("没有写入。看过上面之后，把该加的都加齐，" +
				"再带 -i-know-this-gates-the-fleet 重跑")
		}
	}

	var noteValue any
	if strings.TrimSpace(note) != "" {
		noteValue = note
	}
	_, err = db.ExecContext(ctx, `
		INSERT INTO app.supported_devices
		    (usb_vendor, usb_product, strategy, enabled, note, added_by)
		VALUES ($1, $2, $3, true, $4, $5)
		ON CONFLICT (usb_vendor, usb_product) DO UPDATE
		   SET strategy = excluded.strategy,
		       enabled = true,
		       note = COALESCE(excluded.note, app.supported_devices.note),
		       updated_at = now()`,
		vendor, product, strategy, noteValue, by)
	if err != nil {
		return fmt.Errorf("insert: %w", err)
	}
	fmt.Printf("已加入：%s:%s（%s）\n", vendor, product, strategy)
	fmt.Println()
	fmt.Println("下一步：跑 publish-ledger 把新的矩阵推给机队，否则边缘端读到的")
	fmt.Println("还是上一版文档 —— 这张表只在渲染文档的那一刻被读。")
	return nil
}

func runSetEnabled(ctx context.Context, db *sql.DB, vendor, product, by string, enabled bool) error {
	vendor, product = strings.ToLower(strings.TrimSpace(vendor)), strings.ToLower(strings.TrimSpace(product))
	if err := checkUsbID("vendor", vendor); err != nil {
		return err
	}
	if err := checkUsbID("product", product); err != nil {
		return err
	}
	if strings.TrimSpace(by) == "" {
		return fmt.Errorf("-by 是必填的")
	}

	// 停用之前先说清代价：这一下会让机队上跑着这款硬件的模组全部落到闸外。
	if !enabled {
		fleet, err := fleetInventory(ctx, db)
		if err != nil {
			return err
		}
		for _, device := range fleet {
			if device.vendor == vendor && device.product == product {
				fmt.Printf("⚠️  机队上有 %d 根在管的模组坐在 %s:%s（%s）上。\n",
					device.managed, vendor, product, device.family)
				fmt.Println("   停用之后它们会被闸标记并开始走隔离期。")
				fmt.Println()
			}
		}
	}

	result, err := db.ExecContext(ctx, `
		UPDATE app.supported_devices
		   SET enabled = $3, updated_at = now()
		 WHERE usb_vendor = $1 AND usb_product = $2`,
		vendor, product, enabled)
	if err != nil {
		return fmt.Errorf("update: %w", err)
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed == 0 {
		return fmt.Errorf("目录里没有 %s:%s", vendor, product)
	}
	state := "已启用"
	if !enabled {
		state = "已停用"
	}
	fmt.Printf("%s：%s:%s\n", state, vendor, product)
	fmt.Println("记得跑 publish-ledger 把改动推给机队。")
	return nil
}

// lockedOut 算出机队上哪些硬件不在目录里 —— 也就是这张表一旦非空，
// 谁会被闸挡在外面。
//
// 算错的代价不对称：多报一个只是虚惊，漏报一个就是运维在不知情的情况下把
// 自己的机队关在门外，而且已纳管的那些会开始走隔离期倒计时。所以这里不做
// 任何「大概是同一款」的模糊匹配 —— 键是 vid:pid 精确串，和边缘端
// `edge_core::UsbIdentity` 比对时用的是同一个形状。
//
// 按影响的模组数降序：运维先看到最疼的那一条。
func lockedOut(covered map[string]bool, fleet []fleetDevice) []fleetDevice {
	var out []fleetDevice
	for _, device := range fleet {
		if !covered[key(device.vendor, device.product)] {
			out = append(out, device)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].managed > out[j].managed })
	return out
}

func key(vendor, product string) string { return vendor + ":" + product }

// checkUsbID 挡住格式不对的 id。
//
// 不是洁癖：闸在边缘端是按字符串精确比对的（edge_core::UsbIdentity），
// 一条 "2C7C" 或者 " 2c7c" 会安静地谁也匹配不上 —— 表里有这一行，运维以为
// 加过了，而硬件照样被拒。
func checkUsbID(what, value string) error {
	if len(value) != 4 {
		return fmt.Errorf("-%s 要四位十六进制，收到 %q", what, value)
	}
	for _, r := range value {
		if (r < '0' || r > '9') && (r < 'a' || r > 'f') {
			return fmt.Errorf("-%s 要四位十六进制小写，收到 %q", what, value)
		}
	}
	return nil
}
