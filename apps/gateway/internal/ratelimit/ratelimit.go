// Package ratelimit bounds how often one caller can do something expensive or
// dangerous.
//
// Nothing here was limited. `/v1/auth/login` accepted passwords as fast as a
// client could send them, which makes an eight-character password a matter of
// hours; `/v1/commands` accepted commands as fast as a client could send them,
// which fills a device's queue with work it will spend an hour refusing.
package ratelimit

import (
	"sync"
	"time"
)

// Limiter is a token bucket per key.
//
// A bucket rather than a fixed window: a fixed window lets a caller spend the
// whole allowance in the last instant of one window and the whole of the next
// in the first instant of the following one, which is twice the intended rate
// at exactly the moment it matters. A bucket also allows a short burst, which
// is what an operator clicking through a device page actually looks like.
type Limiter struct {
	mu      sync.Mutex
	buckets map[string]*bucket
	// rate is tokens added per second.
	rate float64
	// burst is the most tokens a bucket can hold.
	burst float64
	// idle is how long an untouched bucket is kept before being forgotten.
	idle time.Duration
	now  func() time.Time
}

type bucket struct {
	tokens float64
	seen   time.Time
}

// New returns a limiter allowing `burst` immediately and `rate` per second
// thereafter.
func New(rate float64, burst int) *Limiter {
	return &Limiter{
		buckets: map[string]*bucket{},
		rate:    rate,
		burst:   float64(burst),
		// Ten minutes of silence and the bucket is gone. Without an expiry the
		// map grows once per distinct key forever, and the keys here include
		// client IPs.
		idle: 10 * time.Minute,
		now:  time.Now,
	}
}

// Allow reports whether this key may proceed, and consumes a token if so.
func (limiter *Limiter) Allow(key string) bool {
	limiter.mu.Lock()
	defer limiter.mu.Unlock()

	now := limiter.now()
	current, ok := limiter.buckets[key]
	if !ok {
		limiter.sweep(now)
		current = &bucket{tokens: limiter.burst, seen: now}
		limiter.buckets[key] = current
	}

	elapsed := now.Sub(current.seen).Seconds()
	if elapsed > 0 {
		current.tokens += elapsed * limiter.rate
		if current.tokens > limiter.burst {
			current.tokens = limiter.burst
		}
	}
	current.seen = now

	if current.tokens < 1 {
		return false
	}
	current.tokens--
	return true
}

// RetryAfter is how long until this key would be allowed again. Zero when it
// is allowed now.
func (limiter *Limiter) RetryAfter(key string) time.Duration {
	limiter.mu.Lock()
	defer limiter.mu.Unlock()

	current, ok := limiter.buckets[key]
	if !ok || current.tokens >= 1 {
		return 0
	}
	needed := 1 - current.tokens
	return time.Duration(needed / limiter.rate * float64(time.Second))
}

// sweep drops buckets nobody has touched recently. Called when a new key
// arrives, which is the only moment the map can grow.
func (limiter *Limiter) sweep(now time.Time) {
	for key, current := range limiter.buckets {
		if now.Sub(current.seen) > limiter.idle {
			delete(limiter.buckets, key)
		}
	}
}
