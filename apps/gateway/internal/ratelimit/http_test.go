package ratelimit

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"
)

func mustTrust(t *testing.T, spec string) []netip.Prefix {
	t.Helper()
	prefixes, err := TrustedProxies(spec)
	if err != nil {
		t.Fatalf("解析 %q：%v", spec, err)
	}
	return prefixes
}

// 代理后面的两个调用方，拿到的是两个桶。
//
// 🔴 这是生产上真正的形状，而在此之前钉它的那条测试是假绿：
//
//	`TestOneAddressBeingLimitedDoesNotAffectAnother` 直接给两个 httptest 请求
//	写不同的 `RemoteAddr`，制造出这套部署**永远造不出来**的两个对端地址 ——
//	浏览器的 /v1/* 走 Next 的 rewrite、登录走 console 的服务端 fetch，网关看到
//	的对端永远是 console 容器那一个。于是那条测试报的性质在部署里是假的。
func TestTwoCallersBehindOneProxyGetSeparateBuckets(t *testing.T) {
	t.Parallel()

	key := ClientKeyBehind(mustTrust(t, "172.20.0.0/16"))
	first := request("172.20.0.4:5000", "203.0.113.9")
	second := request("172.20.0.4:5001", "198.51.100.4")

	if key(first) == key(second) {
		t.Fatalf("同一个代理后面的两个调用方共用了一个桶：%s", key(first))
	}
	if got := key(first); got != "203.0.113.9" {
		t.Fatalf("键 = %q，期望转述过来的那个地址", got)
	}
}

// 不可信的对端说自己是谁，一律不算数。
//
// 🔴 这是这整件事里唯一会把「限流」变成「没有限流」的方向：信了任何人送来的
//
//	这个头，调用方就可以每次换一个值，一人一桶等于无限。
func TestAnUntrustedPeerCannotChooseItsOwnBucket(t *testing.T) {
	t.Parallel()

	key := ClientKeyBehind(mustTrust(t, "172.20.0.0/16"))
	first := request("203.0.113.9:5000", "10.0.0.1")
	second := request("203.0.113.9:5001", "10.0.0.2")

	if key(first) != key(second) {
		t.Fatal("不可信的对端换个头就换了个桶 —— 那等于没有限流")
	}
	if got := key(first); got != "203.0.113.9" {
		t.Fatalf("键 = %q，期望对端地址本身", got)
	}
}

// 可信代理没转述时，退回共用一个桶 —— 但看得出来是共用的。
//
// ⚠️ 这一支是「代理没告诉我调用方是谁」，不是「调用方就是这个代理」。行为和
//
//	修复前一样，而 `proxy:` 前缀让它在调试时不至于伪装成一个正常的按地址限流。
func TestATrustedProxyThatSaysNothingFallsBackVisibly(t *testing.T) {
	t.Parallel()

	key := ClientKeyBehind(mustTrust(t, "172.20.0.0/16"))
	got := key(request("172.20.0.4:5000", ""))
	if got != "proxy:172.20.0.4" {
		t.Fatalf("键 = %q，期望 proxy:172.20.0.4", got)
	}
}

// 转述过来的东西不是一个地址时，同样不算数。
func TestAMalformedForwardedAddressIsNotABucket(t *testing.T) {
	t.Parallel()

	key := ClientKeyBehind(mustTrust(t, "172.20.0.0/16"))
	for _, junk := range []string{"not-an-address", "203.0.113.9, 10.0.0.1", "203.0.113.9:80"} {
		if got := key(request("172.20.0.4:5000", junk)); got != "proxy:172.20.0.4" {
			t.Errorf("转述值 %q 被当成了桶 %q", junk, got)
		}
	}
}

// 没有配信任名单时，行为和以前逐字相同。
//
// ⚠️ 负面对照：默认谁都不信。少了这一条，一个「总是读那个头」的实现也能让上面
//
//	几条变绿，而那样任何直连得到网关的东西都能自选限流桶。
func TestWithNoTrustListTheHeaderIsIgnoredEntirely(t *testing.T) {
	t.Parallel()

	key := ClientKeyBehind(nil)
	if got := key(request("172.20.0.4:5000", "203.0.113.9")); got != "172.20.0.4" {
		t.Fatalf("没配信任名单却读了转述头：%q", got)
	}
}

func TestTrustedProxiesRefusesSomethingThatIsNotANetwork(t *testing.T) {
	t.Parallel()

	if _, err := TrustedProxies("172.20.0.0/16, 不是网段"); err == nil {
		t.Fatal("写错的信任名单被静悄悄接受了 —— 那会让整段配置看起来生效了")
	}
	// 单个地址也接受：一个代理就是一个地址，逼人写 /32 只会写错。
	prefixes, err := TrustedProxies("172.20.0.4")
	if err != nil || len(prefixes) != 1 {
		t.Fatalf("单地址形式没被接受：%v %v", prefixes, err)
	}
}

func request(remote, forwarded string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/v1/auth/login", nil)
	r.RemoteAddr = remote
	if forwarded != "" {
		r.Header.Set(ClientAddressHeader, forwarded)
	}
	return r
}

// 不可信的对端送来这个头时，要留下声音。
//
// 🔴 这一支的真正用处不是拦攻击者（忽略就够了），而是让**自己的控制台掉出
//
//	信任名单**这件事有声音。docker 重编网段、compose 改了网络，都会让
//	VODOGE_TRUSTED_PROXIES 悄悄失配，而失配的后果正是那个全平台共用一个桶的
//	洞原样回来 —— 没有这条日志，它会一声不响地回来。
//
// ⚠️ 这里只能断言「忽略了」这一半：日志用的是包级 slog，测它要换 handler，
//
//	而那会和并行的其它测试抢全局状态。所以这条钉的是行为，日志那一半由上面
//	那段注释和代码里的 Warn 承担。
func TestAForwardedAddressFromAnUntrustedPeerIsIgnored(t *testing.T) {
	t.Parallel()

	key := ClientKeyBehind(mustTrust(t, "172.20.0.0/16"))
	if got := key(request("198.51.100.7:443", "203.0.113.9")); got != "198.51.100.7" {
		t.Fatalf("键 = %q，期望对端地址 —— 不可信的对端不能自己挑桶", got)
	}
}
