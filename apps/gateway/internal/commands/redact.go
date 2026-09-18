package commands

import (
	"encoding/json"
	"reflect"
	"sort"
	"strings"
	"sync"
)

// Redacted 是隐去之后留在原处的占位。
//
// ⚠️ 留占位而不是把键删掉：审计要回答的事实之一正是「这条命令**带过**一次性
//
//	凭据」。删掉键之后，一条下载 eSIM 的记录看起来就和一条没带码的一模一样。
//
// 和 settings.Redacted 用同一串点，理由是运维在两个地方看到的是同一件事。
const Redacted = "••••••••"

// secretKeys 是命令载荷里属于一次性凭据的键。
//
// 🔴 从 `Request` 的 `sensitive:"true"` 标记**反射**出来，不手写第二份名单。
//
//	手写那份的下场这个仓库里已经有了实物：catalog.go:760 的注释写着
//	「configure_apn is the only command carrying a password」，而
//	`download_esim_profile` 后来带着 `activation_code` 进来时，没有人回去改
//	那句话，也没有人回去改那条 `payload - 'password'`。于是生产的
//	app.audit_log 里躺着 2 行明文激活码（2026-09-18 实测），而
//	`GET /v1/audit` 对只读会话是开的 —— 一个连下载命令都不许发的角色，
//	拿到了执行那次下载所需要的凭据本身。
//
// ⚠️ 标记打在 `Request` 上而不是打在目录条目上：凭据是**输入**带进来的，而
//
//	一个新命令复用同一个输入字段时，作者不会想起还要去别处登记一次。
var secretKeys = sync.OnceValue(func() map[string]struct{} {
	keys := map[string]struct{}{}
	fields := reflect.TypeOf(Request{})
	for index := 0; index < fields.NumField(); index++ {
		field := fields.Field(index)
		if field.Tag.Get("sensitive") != "true" {
			continue
		}
		name, _, _ := strings.Cut(field.Tag.Get("json"), ",")
		if name == "" || name == "-" {
			continue
		}
		keys[name] = struct{}{}
	}
	return keys
})

// SecretKeys 是那份名单，排好序，给需要把它交给 SQL 的调用方用。
func SecretKeys() []string {
	keys := make([]string, 0, len(secretKeys()))
	for key := range secretKeys() {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// Redact 复制一份载荷，把一次性凭据换成占位。
//
// ⚠️ 复制而不是就地改：传进来的那一份要原样发给设备 —— 设备重连之后还要再读
//
//	一次，那是这些码存在命令行里的全部理由。就地改会把要发的东西也改了。
//
// ⚠️ 递归下去：今天的载荷都是平的，而「今天是平的」不是一条能靠自己成立的
//
//	前提。嵌套一层就漏一层的隐去，等于没有隐去。
func Redact(payload map[string]any) map[string]any {
	if payload == nil {
		return nil
	}
	secret := secretKeys()
	clone := make(map[string]any, len(payload))
	for key, value := range payload {
		if _, isSecret := secret[key]; isSecret {
			// 空值不换：一个没填的确认码换成点，会让读的人以为填过。
			if text, ok := value.(string); ok && text == "" {
				clone[key] = value
				continue
			}
			clone[key] = Redacted
			continue
		}
		clone[key] = redactValue(value)
	}
	return clone
}

// redactValue 往下走一层。
//
// 🔴 数组**套**数组也要走进去。第一版只对数组里的对象递归，套两层的那一档
//
//	原样放行 —— 而那一版的注释写着「嵌套一层就漏一层的隐去，等于没有隐去」。
//	注释说对了，代码没做到：`[[{"activation_code": …}]]` 会原样进审计行。
//	今天的载荷都是平的，所以这不是一个活着的缺陷；把它修好是因为那句注释
//	现在才成立。
func redactValue(value any) any {
	switch nested := value.(type) {
	case map[string]any:
		return Redact(nested)
	case []any:
		items := make([]any, len(nested))
		for index, item := range nested {
			items[index] = redactValue(item)
		}
		return items
	default:
		return value
	}
}

// RedactJSON 是同一件事，作用在已经序列化好的载荷上。
//
// `BuildPayload` 交出来的就是 []byte —— 命令行里存的是它，审计行里写的也是它。
//
// 🔴 解不开时**不**原样返回。原样返回是「看不懂所以先放过去」，而这个函数存在
//
//	的全部意义就是不让凭据流到下一层；解不开时放过去，等于在最需要它的那一次
//	失效。也不返回空：空会让一条带过凭据的记录看起来像一条什么都没带的记录。
//	返回一句明说「这条隐去失败了」的 JSON，运维看得见，而凭据不在里面。
func RedactJSON(payload []byte) []byte {
	if len(payload) == 0 {
		return payload
	}
	var document map[string]any
	if err := json.Unmarshal(payload, &document); err != nil {
		return []byte(`{"redaction_failed":"payload is not a json object"}`)
	}
	cleaned, err := json.Marshal(Redact(document))
	if err != nil {
		return []byte(`{"redaction_failed":"redacted payload does not marshal"}`)
	}
	return cleaned
}
