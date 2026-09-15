package main

import (
	"context"
	"testing"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/cards"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/commands"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/wss"
)

// 卡策略只在运维改它的那一刻下发一次，之后没有任何对账。
//
// 🔴 2026-09-15 在生产上量到的：云端有三张卡、**全部**声明了 `sms_send: false`，
//
//	而那台设备本地的 `card_policies` 是 **0 行**。历史上 5 次下发里 2 次因设备
//	离线过期、1 次因当时的边缘不认识这个命令而失败，之后再没有人重试。
//
//	`pushCardPolicies` 的头注释自己预见了这件事 —— 「a device that missed one
//	change would otherwise be wrong about that card forever」—— 但补推只在
//	Save / Delete 两个路由上跑。设备离线、命令过期、或者行是用别的方式写进去的，
//	这台机器就永远按「没有任何限制」在跑，而控制台把云端那一行显示成事实。
//
// 所以设备在 Resume 里报一次它手上那套的版本，云端不一致就补推。幂等键是
// `(device, version, payload)`，所以重复的 Resume 不会重复入队。
func TestAStaleDeviceGetsThePolicySetOnResume(t *testing.T) {
	t.Parallel()

	proc := newProcess("", nil, nil, nil, nil)
	store := &cards.Memory{}
	proc.cards = store
	queue := &commands.Memory{}
	proc.queue = queue

	yes := true
	if err := store.Save(context.Background(), "t-1", cards.Policy{
		ICCID:           "8986",
		CellularEnabled: true,
		Vertical:        "iot",
		SmsReceive:      &yes,
	}); err != nil {
		t.Fatal(err)
	}

	// 这台设备手上什么都没有 —— 生产上那台就是这个状态。
	proc.recordResume("t-1", "d-1", wss.DeviceReport{})

	if got := len(queue.Items); got != 1 {
		t.Fatalf("手上没有任何策略的设备没有拿到补推：入队 %d 条", got)
	}
	if kind := queue.Items[0].Kind; kind != commands.CardPolicyKind {
		t.Fatalf("补推的是 %q，不是卡策略", kind)
	}
}

// 负面对照：版本一致就不要发。
//
// 🔴 少了这一条，「每次 Resume 都补推」也能让上面那条变绿 —— 而设备每 5 秒重连
//
//	一次的话，那会变成一台机器每 5 秒收到一条命令。一道永远触发的补推不是对账，
//	它是一个循环。
func TestADeviceOnTheCurrentVersionIsLeftAlone(t *testing.T) {
	t.Parallel()

	proc := newProcess("", nil, nil, nil, nil)
	store := &cards.Memory{}
	proc.cards = store
	queue := &commands.Memory{}
	proc.queue = queue

	if err := store.Save(context.Background(), "t-1", cards.Policy{
		ICCID:           "8986",
		CellularEnabled: true,
		Vertical:        "iot",
	}); err != nil {
		t.Fatal(err)
	}
	current, err := store.Version(context.Background(), "t-1")
	if err != nil {
		t.Fatal(err)
	}

	proc.recordResume("t-1", "d-1", wss.DeviceReport{CardPolicyVersion: current})

	if got := len(queue.Items); got != 0 {
		t.Fatalf("版本已经一致却还是补推了 %d 条 —— 设备每次重连都会再收一条", got)
	}
}

// 租户一条策略都没有的时候，不要给每台设备发一条空推送。
//
// ⚠️ `pushCardPolicies` 本来就在 `len(policies) == 0` 时直接返回（契约要求至少
//
//	一条，而「没有策略」的另一种解读是「全部拒绝」）。这一条钉住对账没有绕开它。
func TestATenantWithNoPoliciesPushesNothing(t *testing.T) {
	t.Parallel()

	proc := newProcess("", nil, nil, nil, nil)
	proc.cards = &cards.Memory{}
	queue := &commands.Memory{}
	proc.queue = queue

	proc.recordResume("t-1", "d-1", wss.DeviceReport{})

	if got := len(queue.Items); got != 0 {
		t.Fatalf("租户没有任何策略却推了 %d 条", got)
	}
}

// 老 agent 不报这个字段，和「报了一个空版本」是同一件事：都没有可执行的限制。
//
// ⚠️ 两者都要补推。契约把这个字段做成**可选**，所以一个没升级的 agent 连上来
//
//	仍然能拿到策略 —— 它会在下一次连上时继续报空，于是每次都补推一条。
//	那是可以接受的：老 agent 是个要修的状态，而多一条命令比一台不设防的机器好。
func TestAnAgentThatReportsNoVersionIsTreatedAsStale(t *testing.T) {
	t.Parallel()

	proc := newProcess("", nil, nil, nil, nil)
	store := &cards.Memory{}
	proc.cards = store
	queue := &commands.Memory{}
	proc.queue = queue
	if err := store.Save(context.Background(), "t-1", cards.Policy{
		ICCID: "8986", CellularEnabled: true, Vertical: "iot",
	}); err != nil {
		t.Fatal(err)
	}

	proc.recordResume("t-1", "d-1", wss.DeviceReport{CardPolicyVersion: ""})

	if got := len(queue.Items); got != 1 {
		t.Fatalf("不报版本的 agent 没有被当成陈旧：入队 %d 条", got)
	}
}
