package uptime

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
)

// ErrInvalid marks a configuration the caller can fix.
var ErrInvalid = errors.New("uptime redis")

// Its own client rather than one borrowed from internal/wakeup.
//
// The two use Redis for unrelated things -- wakeup publishes routing hints
// that may be lost, this accumulates counts that are flushed -- and sharing a
// connection would tie their timeouts and their failure handling together for
// no reason beyond both of them saying "redis".
type redisBroker struct {
	client *redis.Client
}

// Dial builds an uptime broker from REDIS_URL. Ping is left to the caller so a
// failed ping can log and continue rather than take the process down.
func Dial(url string) (*Recorder, *redis.Client, error) {
	url = strings.TrimSpace(url)
	if url == "" {
		return nil, nil, fmt.Errorf("%w: REDIS_URL is empty", ErrInvalid)
	}
	opts, err := redis.ParseURL(url)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: parse REDIS_URL: %v", ErrInvalid, err)
	}
	// Matching internal/wakeup: one attempt, short deadlines. A slow Redis
	// must not hold a frame's handler open -- the recording is a side effect
	// of the frame, and the frame matters more than the minute.
	opts.MaxRetries = 0
	if opts.DialTimeout == 0 {
		opts.DialTimeout = 2 * time.Second
	}
	if opts.ReadTimeout == 0 {
		opts.ReadTimeout = time.Second
	}
	if opts.WriteTimeout == 0 {
		opts.WriteTimeout = time.Second
	}
	opts.ContextTimeoutEnabled = true
	client := redis.NewClient(opts)
	return NewRecorder(redisBroker{client: client}), client, nil
}

func (b redisBroker) SetBit(ctx context.Context, key string, offset int64, value int) error {
	return b.client.SetBit(ctx, key, offset, value).Err()
}

func (b redisBroker) BitCount(ctx context.Context, key string) (int64, error) {
	count, err := b.client.BitCount(ctx, key, nil).Result()
	if errors.Is(err, redis.Nil) {
		return 0, nil
	}
	return count, err
}

func (b redisBroker) SAdd(ctx context.Context, key, member string) error {
	return b.client.SAdd(ctx, key, member).Err()
}

func (b redisBroker) SMembers(ctx context.Context, key string) ([]string, error) {
	members, err := b.client.SMembers(ctx, key).Result()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	return members, err
}

func (b redisBroker) Expire(ctx context.Context, key string, ttl time.Duration) error {
	return b.client.Expire(ctx, key, ttl).Err()
}

func (b redisBroker) Del(ctx context.Context, keys ...string) error {
	if len(keys) == 0 {
		return nil
	}
	return b.client.Del(ctx, keys...).Err()
}
