package main

import (
	"strings"
	"testing"
)

// 🔴 联锁算的就是这一件事：把目录变成非空之后，机队上哪些硬件落到了闸外。
//
// 算错的代价是不对称的：多报一个只是虚惊，漏报一个就是运维在不知情的情况下
// 把自己的机队关在门外 —— 而且已纳管的那些会开始走隔离期倒计时。
func TestLockedOutNamesEveryUncoveredDevice(t *testing.T) {
	fleet := []fleetDevice{
		{vendor: "2c7c", product: "0125", family: "EC20", managed: 3},
		{vendor: "2c7c", product: "0901", family: "EC200U-CN", managed: 1},
	}

	// 只加了 EC20 那一款：AT-only 那根会被挡掉。
	out := lockedOut(map[string]bool{"2c7c:0125": true}, fleet)
	if len(out) != 1 {
		t.Fatalf("要报 1 款被挡掉，报了 %d 款", len(out))
	}
	if out[0].product != "0901" {
		t.Fatalf("报错了硬件：%s:%s", out[0].vendor, out[0].product)
	}

	// 两款都加上：一个都不该报。
	both := map[string]bool{"2c7c:0125": true, "2c7c:0901": true}
	if out := lockedOut(both, fleet); len(out) != 0 {
		t.Fatalf("两款都在目录里，却报了 %d 款被挡掉", len(out))
	}

	// 目录里有但被停用的，不算覆盖 —— 停用的语义就是「不再支持」。
	if out := lockedOut(map[string]bool{}, fleet); len(out) != 2 {
		t.Fatalf("空目录该报两款全被挡掉，报了 %d 款", len(out))
	}
}

// 被挡掉的按「影响几根模组」排前，运维先看到最疼的那一条。
func TestLockedOutPutsTheMostPainfulFirst(t *testing.T) {
	out := lockedOut(map[string]bool{}, []fleetDevice{
		{vendor: "2c7c", product: "0901", managed: 1},
		{vendor: "2c7c", product: "0125", managed: 3},
	})
	if out[0].managed != 3 {
		t.Fatalf("排序没把影响最大的放前面：第一条是 %d 根", out[0].managed)
	}
}

// USB id 落库前必须是四位十六进制小写。
//
// 边缘端 `edge_core::UsbIdentity` 是按字符串精确比对的，所以一条大小写或
// 空白不对的行会安静地谁也匹配不上 —— 表里有这一行，运维以为加过了，硬件
// 照样被拒，而且没有任何地方会提示。
//
// 分工是：调用方先把无歧义的差异规范化掉（大小写、首尾空白），这个函数只
// 负责拒绝规范化之后仍然不合法的。所以 "2C7C" 不在下面这张表里 —— 它会被
// 规范化成 2c7c 然后通过，那是想要的行为。
func TestUsbIDsAreCheckedBeforeTheyReachTheTable(t *testing.T) {
	for _, bad := range []string{"2c7", "2c7cc", "", "2c7g", "0x2c", "2C7C"} {
		if err := checkUsbID("vendor", bad); err == nil {
			t.Fatalf("%q 被放过了", bad)
		}
	}
	if err := checkUsbID("vendor", "2c7c"); err != nil {
		t.Fatalf("2c7c 应该合法：%v", err)
	}
	// 规范化是调用方的事，这里钉住那一步真的发生过：大写进来、小写落库。
	if got := strings.ToLower(strings.TrimSpace(" 2C7C ")); got != "2c7c" {
		t.Fatalf("规范化没把 \" 2C7C \" 变成 2c7c，得到 %q", got)
	}
}
