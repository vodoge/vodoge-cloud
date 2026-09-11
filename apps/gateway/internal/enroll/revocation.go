package enroll

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"database/sql"
	"errors"
	"sync"
	"time"

	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/identity"
	"github.com/vodoge/vodoge-cloud/apps/gateway/internal/tenant"
)

// SQLRevocations answers whether a device certificate was taken back.
//
// 🔴 在这之前**没有任何地方查过** `app.device_certificates.revoked_at`。
//
//	那一列从 0006 就在，而认证路径只信 CA 签名 —— 任何这个 CA 签过的证书
//	都永久有效。机器丢了收不回来，而现役那张证书有效到 2028-08-31。
//
// ⚠️ 判据是**指纹**（leaf DER 的 SHA-256），不是 serial。serial 只在单个 CA
//
//	内唯一，而这套东西将来要换 CA（轮换、或者多区域各一个），那时两张不同
//	的证书可以有同一个 serial。指纹没有这个问题。
type SQLRevocations struct {
	DB *sql.DB
	// TTL 是一条判定在缓存里活多久。零值用默认。
	TTL time.Duration

	once  sync.Once
	mu    sync.Mutex
	cache map[string]cachedVerdict
}

type cachedVerdict struct {
	revoked bool
	until   time.Time
}

// defaultRevocationTTL 是一次判定的有效期。
//
// ⚠️ 这个值是一次取舍，两边都有代价：长了，吊销生效慢；短了，一次重连风暴
//
//	就是一轮数据库查询。60 秒的理由是**边缘的重连节奏**：uplink_loop 失败后
//	固定 sleep 5 秒，所以一台在重连循环里的设备一分钟会敲十二次门，而缓存
//	把它压成一次。而吊销的场景（机器丢了）里，一分钟不是一个有意义的差别。
const defaultRevocationTTL = time.Minute

// Revoked reports whether this handshake's leaf certificate has been revoked.
func (store *SQLRevocations) Revoked(
	ctx context.Context,
	device identity.Device,
	state *tls.ConnectionState,
) (bool, error) {
	if store == nil || store.DB == nil {
		return false, nil
	}
	leaf := leafOf(state)
	if leaf == nil {
		// 没有证书就走不到这里（身份就是从它读出来的）。真发生了就说不知道，
		// 让调用方按「查不到」处理 —— 而不是按「没被吊销」。
		return false, errors.New("handshake carried no certificate")
	}
	fingerprint := Fingerprint(leaf)

	store.once.Do(func() {
		store.cache = make(map[string]cachedVerdict)
		if store.TTL <= 0 {
			store.TTL = defaultRevocationTTL
		}
	})

	now := time.Now()
	store.mu.Lock()
	if hit, ok := store.cache[fingerprint]; ok && now.Before(hit.until) {
		store.mu.Unlock()
		return hit.revoked, nil
	}
	store.mu.Unlock()

	var revoked bool
	err := tenant.Transact(ctx, store.DB, device.TenantID, func(tx *sql.Tx) error {
		return tx.QueryRowContext(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM app.device_certificates
				 WHERE fingerprint = $1
				   AND revoked_at IS NOT NULL
			)`, fingerprint).Scan(&revoked)
	})
	if err != nil {
		// 🔴 **不缓存失败**。缓存一个「查不出来」等于把一次瞬时故障变成
		//    一分钟的盲区，而这一分钟里吊销是不生效的。
		return false, err
	}

	store.mu.Lock()
	store.cache[fingerprint] = cachedVerdict{revoked: revoked, until: now.Add(store.TTL)}
	store.mu.Unlock()
	return revoked, nil
}

// leafOf picks the verified leaf out of a handshake, the same way identity does.
func leafOf(state *tls.ConnectionState) *x509.Certificate {
	if state == nil || len(state.PeerCertificates) == 0 {
		return nil
	}
	leaf := state.PeerCertificates[0]
	if len(state.VerifiedChains) > 0 && len(state.VerifiedChains[0]) > 0 {
		leaf = state.VerifiedChains[0][0]
	}
	return leaf
}
