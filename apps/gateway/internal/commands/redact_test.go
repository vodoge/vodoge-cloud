package commands

import (
	"encoding/json"
	"strings"
	"testing"
)

// 哨兵串。出现在任何一条隐去之后的载荷里，就是一次泄漏。
const (
	sentinelActivation   = "SENTINELACTIVATIONCODE"
	sentinelConfirmation = "SENTINELCONFIRMATIONCODE"
	sentinelPassword     = "SENTINELAPNPASSWORD"
	sentinelPublic       = "SENTINELPUBLICVALUE"
)

// 一个尽量能通过各条 Build 校验的请求，凭据字段里埋着哨兵。
func sentinelRequest(kind string) Request {
	password := sentinelPassword
	username := "operator"
	enabled := true
	cid := 1
	nickname := "profile"
	var sequence int64 = 1
	limit := 10
	var after uint64
	return Request{
		DeviceID:  "11111111-1111-4111-8111-111111111111",
		Kind:      kind,
		ModemIMEI: "860000000000001",
		To:        "10086",
		// 🔴 短信正文里也埋一个哨兵，但用的是**非**凭据的那一个：它必须**活着**
		//    出来。少了这一条，一个「把所有字符串都换成点」的实现也能让这条
		//    测试变绿，而那样的审计行什么都不再说明。
		Body:             sentinelPublic,
		Command:          "AT+CPIN?",
		TimeoutMs:        1000,
		Code:             "*100#",
		Stage:            "start",
		Enabled:          &enabled,
		Mode:             "auto",
		PLMN:             "46000",
		ProfileICCID:     "8986003031401770106",
		Nickname:         &nickname,
		CandidateKey:     "candidate",
		Note:             "note",
		Family:           "EC20",
		LogAfter:         &after,
		LogLimit:         &limit,
		LogContains:      "boot",
		CID:              &cid,
		PDPType:          "IPV4V6",
		APN:              "cmnet",
		Username:         &username,
		Password:         &password,
		Auth:             "pap",
		UsbnetMode:       "ecm",
		TargetICCID:      "8986003031401770106",
		SequenceNumber:   &sequence,
		SmdpAddress:      "smdp.example.com",
		ActivationCode:   "1$smdp.example.com$" + sentinelActivation,
		ConfirmationCode: sentinelConfirmation,
		Version:          "1.2.3",
		URL:              "https://example.com/agent",
		SHA256:           strings.Repeat("a", 64),
		Signature:        strings.Repeat("b", 64),
	}
}

// 目录里的每一条命令，隐去之后都不许带出一次性凭据。
//
// 🔴 这条测试查的是**值**，不是键名。一个新命令把 `request.ActivationCode`
//
//	写进 `payload["esim_code"]`，键名对不上任何名单，而哨兵会原样出现在
//	隐去之后的 JSON 里 —— 于是这条测试红。这正是当初漏掉的那个形状：
//	`configure_apn` 的 password 处理过了，`download_esim_profile` 带着新的
//	凭据字段进来，没有任何东西注意到。
//
// ⚠️ 会 Build 失败的命令跳过（一个请求不可能同时满足 33 条校验），但下面有
//
//	一条「至少要有多少条真的建起来」的下限，以及一条「隐去之前哨兵确实在里面」
//	的负面对照 —— 没有这两条，全部跳过也会绿。
func TestNoCommandLeaksAOneTimeCredentialIntoItsAuditedPayload(t *testing.T) {
	t.Parallel()

	secrets := []string{sentinelActivation, sentinelConfirmation, sentinelPassword}
	built, carried := 0, 0

	for _, kind := range Kinds() {
		_, payload, err := BuildPayload(sentinelRequest(kind))
		if err != nil {
			continue
		}
		built++
		raw := string(payload)
		for _, sentinel := range secrets {
			if strings.Contains(raw, sentinel) {
				carried++
				break
			}
		}

		redacted := string(RedactJSON(payload))
		for _, sentinel := range secrets {
			if strings.Contains(redacted, sentinel) {
				t.Errorf("%s 的载荷隐去之后仍然带着一次性凭据：%s\n"+
					"审计行是只追加、从不删除的，而 GET /v1/audit 对只读会话开放。",
					kind, redacted)
			}
		}
	}

	if built < 10 {
		t.Fatalf("只有 %d 条命令建起来了 —— 这条测试基本上什么都没查到。"+
			"多半是 sentinelRequest 的某个字段不再通过校验了。", built)
	}
	if carried == 0 {
		t.Fatal("没有任何一条命令在隐去之前带着哨兵 —— 那么上面那段循环" +
			"证明不了任何事。多半是哨兵没走到载荷里。")
	}
}

// 隐去不能把不该隐的一起隐掉。
func TestRedactingKeepsEverythingThatIsNotACredential(t *testing.T) {
	t.Parallel()

	_, payload, err := BuildPayload(sentinelRequest("send_sms"))
	if err != nil {
		t.Fatalf("send_sms 建不起来：%v", err)
	}
	redacted := string(RedactJSON(payload))
	if !strings.Contains(redacted, sentinelPublic) {
		t.Fatalf("短信正文被一起隐去了：%s\n"+
			"一条什么都读不出来的审计行，和没有这条审计行是一样的。", redacted)
	}
}

// 名单是从 Request 的标记反射出来的，而不是写死的。
//
// ⚠️ 这条断言不重复标记本身（那就成了把同一份名单抄两遍），它查的是**反射这条
//
//	路走通了**：一个字段标了 sensitive 就必须出现在 SecretKeys() 里。拿一个
//	临时结构体做不到 —— secretKeys 读的是 Request —— 所以这里用 Request 上
//	已经标好的那几个字段，只确认「数量不为零」以及「标了的都在」。
func TestSecretKeysComeFromTheStructTags(t *testing.T) {
	t.Parallel()

	keys := SecretKeys()
	if len(keys) == 0 {
		t.Fatal("一个凭据键都没反射出来 —— 隐去会变成一个什么都不做的函数")
	}
	found := map[string]bool{}
	for _, key := range keys {
		found[key] = true
	}
	// Request 上现在标着的三个。改标记时这里要一起改 —— 而那正是应该被人
	// 看见的一次改动。
	for _, want := range []string{"activation_code", "confirmation_code", "password"} {
		if !found[want] {
			t.Errorf("%s 没有出现在 SecretKeys() 里", want)
		}
	}
}

// 解不开的载荷不能原样放行。
//
// 🔴 「看不懂所以先放过去」是这个函数最容易写坏的一处：它会在最需要它的那一次
//
//	失效。也不能返回空 —— 那会让一条带过凭据的记录看起来像什么都没带。
func TestAnUnparsablePayloadIsNotPassedThrough(t *testing.T) {
	t.Parallel()

	junk := []byte(`{"activation_code":"` + sentinelActivation + `"`) // 少一个右括号
	out := string(RedactJSON(junk))
	if strings.Contains(out, sentinelActivation) {
		t.Fatalf("解不开的载荷被原样放行了：%s", out)
	}
	if out == "" {
		t.Fatal("解不开就返回空 —— 那条记录会看起来像一条没带过凭据的记录")
	}
	var document map[string]any
	if err := json.Unmarshal([]byte(out), &document); err != nil {
		t.Fatalf("隐去失败时返回的东西不是合法 JSON：%s", out)
	}
}

// 数组套数组也要隐去。
//
// 🔴 对抗复审抓到的：第一版只对数组里的**对象**递归，套两层的那一档原样放行。
//
//	而同一段代码的注释写着「嵌套一层就漏一层的隐去，等于没有隐去」—— 注释说
//	对了，代码没做到。今天的载荷都是平的，所以这不是一个活着的缺陷；修它是
//	因为那句注释现在才成立。
func TestRedactingReachesIntoNestedArrays(t *testing.T) {
	t.Parallel()

	payload := map[string]any{
		"batch": []any{
			[]any{
				map[string]any{"activation_code": sentinelActivation},
			},
		},
	}
	out, err := json.Marshal(Redact(payload))
	if err != nil {
		t.Fatalf("序列化：%v", err)
	}
	if strings.Contains(string(out), sentinelActivation) {
		t.Fatalf("数组套数组里的凭据没有被隐去：%s", out)
	}
	if !strings.Contains(string(out), Redacted) {
		t.Fatalf("隐去之后连占位都没有：%s", out)
	}
}
