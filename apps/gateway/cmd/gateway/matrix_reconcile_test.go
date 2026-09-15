package main

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/commands"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/matrix"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/wss"
)

func storedOverlay(t *testing.T, store matrix.Store, tenantID, version string) {
	t.Helper()
	if err := store.Put(context.Background(), tenantID, matrix.Overlay{
		Version:  version,
		SHA256:   "0000000000000000000000000000000000000000000000000000000000000000",
		Document: json.RawMessage(`{"version":"` + version + `","rules":[]}`),
	}); err != nil {
		t.Fatal(err)
	}
}

// 能力矩阵和卡策略是同一个缺口：只在发布那一刻下发一次，之后没有对账。
//
// 设备在 Resume 里报 `capability_matrix_version`，云端此前**只记录不比对**
// （`recordResume` 把它写进设备行，`catalog` 展示它，仅此而已）。一台在发布时
// 离线的机器会一直跑在回落的内置矩阵上。
//
// ⚠️ 和卡策略那一侧不同的是，漂移的方向在这里是**安全**的：回落到内置矩阵意味着
//
//	设备把绝大多数 (型号, 运营商) 读成「没测过」，于是**拒绝**它本可以做的事，
//	而不是放行不该放的；而且 `MatrixAuthority` 会因此禁止追溯解绑。所以这不是
//	一个正在咬人的缺陷（2026-09-15 量过：云端和设备都是
//	`2026-09-05T07:36:10Z`）。补它是为了收掉这一类，而不是救火。
func TestADeviceOnAnOlderMatrixGetsItOnResume(t *testing.T) {
	t.Parallel()

	proc := newProcess("", nil, nil, nil, nil)
	store := &matrix.Memory{}
	proc.matrix = store
	queue := &commands.Memory{}
	proc.queue = queue
	storedOverlay(t, store, "t-1", "2026-09-05T07:36:10Z")

	proc.recordResume("t-1", "d-1", wss.DeviceReport{MatrixVersion: "2026-08-01T00:00:00Z"})

	if got := len(queue.Items); got != 1 {
		t.Fatalf("跑在旧矩阵上的设备没有拿到补推：入队 %d 条", got)
	}
	if kind := queue.Items[0].Kind; kind != commands.MatrixKind {
		t.Fatalf("补推的是 %q，不是矩阵", kind)
	}
}

// 负面对照：版本一致就不要发。
//
// 🔴 少了这一条，「每次 Resume 都补推」也能让上面那条变绿 —— 而设备每 5 秒重连
//
//	一次的话那是一个循环，不是对账。这和卡策略那一侧是同一条理由。
func TestADeviceOnTheCurrentMatrixIsLeftAlone(t *testing.T) {
	t.Parallel()

	proc := newProcess("", nil, nil, nil, nil)
	store := &matrix.Memory{}
	proc.matrix = store
	queue := &commands.Memory{}
	proc.queue = queue
	storedOverlay(t, store, "t-1", "2026-09-05T07:36:10Z")

	proc.recordResume("t-1", "d-1", wss.DeviceReport{MatrixVersion: "2026-09-05T07:36:10Z"})

	if got := len(queue.Items); got != 0 {
		t.Fatalf("版本已经一致却还是补推了 %d 条", got)
	}
}

// 云端一份矩阵都没有的时候，不要推。
//
// 🔴 这一条比它看起来重要。云端没有矩阵**不代表**设备该被清空：设备手上那份
//
//	（哪怕是内置的）是它今天唯一的判据，而推一份空的过去会把它读成
//	「什么都没测过」，进而拒绝整支机队的每一个操作。`matrix.Empty` 在没有配
//	PostgreSQL 时正是这个状态。
func TestATenantWithNoStoredMatrixPushesNothing(t *testing.T) {
	t.Parallel()

	proc := newProcess("", nil, nil, nil, nil)
	proc.matrix = &matrix.Memory{}
	queue := &commands.Memory{}
	proc.queue = queue

	proc.recordResume("t-1", "d-1", wss.DeviceReport{MatrixVersion: "2026-08-01T00:00:00Z"})

	if got := len(queue.Items); got != 0 {
		t.Fatalf("云端没有矩阵却推了 %d 条 —— 那会把设备清成「什么都没测过」", got)
	}
}
