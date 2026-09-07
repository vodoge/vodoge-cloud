package catalog

import "testing"

// 号码那一格空着的时候，得说清是哪一种空。
//
// 🔴 这个测试存在的理由是一次真实的坏答案：号码曾经无条件继承，换卡之后上一张卡
// 的号码会挂在新卡名下显示。0062 把它修成了「换卡即作废」——正确，但代价是号码会
// 突然变空，而空跟「这张卡本来就没号码」长得一模一样。运维正是靠这一格认卡的。
func TestMsisdnPendingSaysWhichKindOfEmpty(t *testing.T) {
	p := func(v string) *string { return &v }
	qmi := p("qmi")

	for _, c := range []struct {
		name        string
		msisdn      *string
		msisdnIccid *string
		iccid       *string
		discovery   *string
		want        bool
	}{
		{"有号码就没有悬念", p("+8613800138000"), p("8986001"), p("8986001"), qmi, false},
		{"问过了、这张卡没号码 —— 这是个结论", nil, p("8986001"), p("8986001"), qmi, false},
		{"换了卡、还没问出来", nil, p("8986001"), p("8986002"), qmi, true},
		{"换卡且这轮读失败，指针被清了", nil, nil, p("8986002"), qmi, true},
		{"根本没有卡，没什么可等的", nil, nil, nil, qmi, false},
		{"AT 路每轮重问，指针永远是空的", nil, nil, p("8986003"), p("at"), false},
		{"号码在手上，AT 也不待读", p("+8613800138000"), nil, p("8986003"), p("at"), false},
		{"discovery 缺失时不当成 AT", nil, nil, p("8986004"), nil, true},
	} {
		if got := msisdnPending(c.msisdn, c.msisdnIccid, c.iccid, c.discovery); got != c.want {
			t.Errorf("%s: msisdnPending = %v, 要 %v", c.name, got, c.want)
		}
	}
}
