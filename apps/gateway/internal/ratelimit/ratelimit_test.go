package ratelimit

import (
	"testing"
	"time"
)

func TestABurstIsAllowedAndThenTheRateApplies(t *testing.T) {
	t.Parallel()

	limiter := New(1, 3)
	clock := time.Unix(0, 0)
	limiter.now = func() time.Time { return clock }

	// The burst is what an operator clicking through a page looks like.
	for i := 0; i < 3; i++ {
		if !limiter.Allow("someone") {
			t.Fatalf("request %d in the burst was refused", i+1)
		}
	}
	if limiter.Allow("someone") {
		t.Fatal("the fourth request should exceed the burst")
	}

	// One token per second thereafter.
	clock = clock.Add(time.Second)
	if !limiter.Allow("someone") {
		t.Fatal("a token should have refilled after a second")
	}
	if limiter.Allow("someone") {
		t.Fatal("only one token refills per second")
	}
}

func TestOneCallerCannotExhaustAnother(t *testing.T) {
	t.Parallel()

	limiter := New(1, 2)
	clock := time.Unix(0, 0)
	limiter.now = func() time.Time { return clock }

	for i := 0; i < 2; i++ {
		limiter.Allow("noisy")
	}
	if limiter.Allow("noisy") {
		t.Fatal("the noisy caller should be out of tokens")
	}
	// A shared bucket would be a denial of service handed to anyone who asks
	// for it.
	if !limiter.Allow("quiet") {
		t.Fatal("a second caller was affected by the first")
	}
}

func TestRetryAfterSaysWhen(t *testing.T) {
	t.Parallel()

	limiter := New(2, 1)
	clock := time.Unix(0, 0)
	limiter.now = func() time.Time { return clock }

	limiter.Allow("someone")
	if limiter.Allow("someone") {
		t.Fatal("the second request should be refused")
	}
	// At two per second a refill takes half a second. Telling the caller is
	// what stops a client from retrying in a tight loop.
	if wait := limiter.RetryAfter("someone"); wait <= 0 || wait > time.Second {
		t.Fatalf("RetryAfter = %v, want something under a second", wait)
	}
	if wait := limiter.RetryAfter("nobody"); wait != 0 {
		t.Fatalf("an untouched key should not be waiting, got %v", wait)
	}
}

// The keys include client IPs, so a limiter that never forgets is a memory
// leak with an attacker-controlled growth rate.
func TestIdleBucketsAreForgotten(t *testing.T) {
	t.Parallel()

	limiter := New(1, 1)
	clock := time.Unix(0, 0)
	limiter.now = func() time.Time { return clock }

	for i := 0; i < 50; i++ {
		limiter.Allow(string(rune('a' + i%26)))
	}
	before := len(limiter.buckets)

	clock = clock.Add(time.Hour)
	limiter.Allow("someone-new")

	if len(limiter.buckets) >= before {
		t.Fatalf("buckets = %d, want the idle ones dropped (was %d)",
			len(limiter.buckets), before)
	}
}
