package ratelimit

import (
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ClientKey identifies the caller for limiting purposes.
//
// The remote address, not a header. `X-Forwarded-For` is set by whoever is
// upstream, and if that includes the internet then the caller chooses their
// own limit bucket — which is the same as having no limit. A deployment
// behind a trusted proxy should pass a KeyFunc that reads the header the proxy
// actually sets, once it is known which one that is.
func ClientKey(request *http.Request) string {
	host, _, err := net.SplitHostPort(request.RemoteAddr)
	if err != nil {
		return request.RemoteAddr
	}
	return host
}

// Guard wraps a handler, refusing callers that are over their limit.
//
// The key function decides what is being limited: per-IP for sign-in, per
// tenant for work that costs a device something.
func Guard(limiter *Limiter, key func(*http.Request) string, next http.HandlerFunc) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		id := key(request)
		if limiter.Allow(id) {
			next(writer, request)
			return
		}
		wait := limiter.RetryAfter(id)
		if wait < time.Second {
			wait = time.Second
		}
		// Saying when turns a client that retries in a tight loop into one
		// that waits, which is most of the point.
		writer.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds()+0.5)))
		http.Error(writer, "too many requests", http.StatusTooManyRequests)
	}
}

// ClientAddressHeader 是可信代理用来转述真实调用方地址的头。
//
// ⚠️ 自定义头而不是 `X-Forwarded-For`：XFF 是一条链，最左边那几段是客户端自己
//
//	写的，右边才是各级代理追加的。要从中取出「第一个不可信的地址」就得知道
//	整条链上哪些是可信的 —— 而这套部署里代理只有一级。让那一级明说一个地址，
//	比让这里去解析一条半可信的链短得多，也少一类解析错误。
const ClientAddressHeader = "X-Vodoge-Client-Address"

// TrustedProxies 解析 `VODOGE_TRUSTED_PROXIES`（逗号分隔的 CIDR）。
//
// 🔴 默认**空**，也就是谁都不信。信任名单写错的方向是「任何人都能自己挑限流
//
//	桶」，等于没有限流；而漏配的方向是回到按对端地址限流 —— 不好，但不是洞。
//	两者之中默认取后者。
//
// 解不开的那一条**不**静悄悄跳过：返回错误，由调用方决定是喊一声还是退出。
func TrustedProxies(spec string) ([]netip.Prefix, error) {
	var prefixes []netip.Prefix
	for _, piece := range strings.Split(spec, ",") {
		piece = strings.TrimSpace(piece)
		if piece == "" {
			continue
		}
		prefix, err := netip.ParsePrefix(piece)
		if err != nil {
			// 也接受写成单个地址的形式。
			addr, addrErr := netip.ParseAddr(piece)
			if addrErr != nil {
				return nil, fmt.Errorf("信任名单里的 %q 既不是 CIDR 也不是地址: %w", piece, err)
			}
			prefix = netip.PrefixFrom(addr, addr.BitLen())
		}
		prefixes = append(prefixes, prefix.Masked())
	}
	return prefixes, nil
}

// ClientKeyBehind 在对端属于可信代理时，用它转述的客户端地址做键。
//
// 🔴 存在的理由是生产拓扑：控制台把每一个 /v1 请求转发给网关（浏览器的 /v1/*
//
//	走 Next 的 rewrite，登录走 `POST /api/auth/login` 里的服务端 fetch），所以
//	网关看到的对端**永远**是 console 容器那一个地址。于是按 `ClientKey` 限流
//	的登录闸，全平台共用一个桶：任何人往 `/api/auth/login` 打五次废凭据就把
//	桶打空，接下来**每一个租户的每一位运维**都登不进去，一个 IP 每 12 秒补一
//	下就能一直压着。
//
//	而 `main.go` 里那段注释说这个设计恰恰是为了避开这种事：「按账号限流会让
//	任何人靠连错五次密码锁死同事」。按对端限流在这套拓扑下没有避开它，只是把
//	被锁的范围从一个账号扩大到了全部账号。
//
// ⚠️ 不可信的对端送来的这个头一律忽略 —— 否则调用方自己挑桶，等于没有限流。
//
// ⚠️ 可信对端**没送**这个头时，退回按对端地址限流，并且把键前缀成 `proxy:`：
//
//	那是「代理没告诉我调用方是谁」，不是「调用方就是这个代理」。行为和修复前
//	一样（共用一个桶），但在日志和调试里看得出来它是共用的。
func ClientKeyBehind(trusted []netip.Prefix) func(*http.Request) string {
	if len(trusted) == 0 {
		return ClientKey
	}
	var missingOnce, untrustedOnce sync.Once
	return func(request *http.Request) string {
		peer := ClientKey(request)
		addr, err := netip.ParseAddr(peer)
		if err != nil {
			return peer
		}
		addr = addr.Unmap()
		isTrusted := false
		for _, prefix := range trusted {
			if prefix.Contains(addr) {
				isTrusted = true
				break
			}
		}
		if !isTrusted {
			// 🔴 不可信的对端送来了这个头，意味着两件事之一：有人在试着自己挑
			//    限流桶，或者**我们自己的控制台不在信任名单里了**（docker 重编
			//    网段就会这样）。后一种是静悄悄退回「全平台共用一个桶」的那个
			//    洞，所以它必须留下声音，而不是无声地按对端地址走。
			if request.Header.Get(ClientAddressHeader) != "" {
				untrustedOnce.Do(func() {
					slog.Warn("不在信任名单里的对端转述了调用方地址，已忽略 —— "+
						"如果这是自己的控制台，说明 VODOGE_TRUSTED_PROXIES 没有覆盖它，"+
						"登录限流正退回全平台共用一个桶",
						"peer", peer, "header", ClientAddressHeader)
				})
			}
			return peer
		}
		forwarded, err := netip.ParseAddr(strings.TrimSpace(request.Header.Get(ClientAddressHeader)))
		if err != nil {
			missingOnce.Do(func() {
				slog.Warn("可信代理没有转述调用方地址，限流退回按代理地址共用一个桶",
					"proxy", peer, "header", ClientAddressHeader)
			})
			return "proxy:" + peer
		}
		return forwarded.Unmap().String()
	}
}
