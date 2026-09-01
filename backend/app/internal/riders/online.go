package riders

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"

	"github.com/hudumika/api-backend/internal/store"
)

const (
	onlineSetKey = "riders:online"
	locationTTL  = 120 * time.Second
)

// ErrLocationNotFound is returned by GetLocation when the rider has no
// stored location (never reported, or expired).
var ErrLocationNotFound = errors.New("riders: no stored location")

// OnlineRegistry tracks the multi-instance online set and per-rider live
// locations in Redis. It is intentionally stateless: dispatch scans and
// location pings work from any API instance.
type OnlineRegistry struct {
	r *store.Redis
}

// NewOnlineRegistry returns a registry over the shared Redis client. A nil
// client (in-memory dev mode) makes every method fail with a clear error.
func NewOnlineRegistry(r *store.Redis) *OnlineRegistry {
	return &OnlineRegistry{r: r}
}

// SetOnline adds the rider to (or removes them from) the online set scored
// by the unix timestamp of the transition.
func (o *OnlineRegistry) SetOnline(ctx context.Context, riderID uuid.UUID, online bool) error {
	if o.r == nil || o.r.Client() == nil {
		return errors.New("riders: online registry requires Redis")
	}
	key := riderID.String()
	if online {
		_, err := o.r.Client().ZAdd(ctx, onlineSetKey, redis.Z{
			Score:  float64(time.Now().Unix()),
			Member: key,
		}).Result()
		if err != nil {
			return fmt.Errorf("riders: zadd online %s: %w", key, err)
		}
		return nil
	}
	if err := o.r.Client().ZRem(ctx, onlineSetKey, key).Err(); err != nil {
		return fmt.Errorf("riders: zrem online %s: %w", key, err)
	}
	return nil
}

// Location stores the latest reported rider position with a short TTL.
func (o *OnlineRegistry) Location(ctx context.Context, riderID uuid.UUID, lat, lon float64, speedKmh, heading, accuracyM *float32, activity string) error {
	if o.r == nil || o.r.Client() == nil {
		return errors.New("riders: online registry requires Redis")
	}
	key := locationKey(riderID)
	c := o.r.Client()
	fields := map[string]interface{}{
		"lat": strconv.FormatFloat(lat, 'f', -1, 64),
		"lon": strconv.FormatFloat(lon, 'f', -1, 64),
		"at":  time.Now().UTC().Format(time.RFC3339),
	}
	if speedKmh != nil {
		fields["speed"] = strconv.FormatFloat(float64(*speedKmh), 'f', -1, 32)
	}
	if heading != nil {
		fields["heading"] = strconv.FormatFloat(float64(*heading), 'f', -1, 32)
	}
	if accuracyM != nil {
		fields["accuracy"] = strconv.FormatFloat(float64(*accuracyM), 'f', -1, 32)
	}
	if activity != "" {
		fields["activity"] = activity
	}
	if err := c.HSet(ctx, key, fields).Err(); err != nil {
		return fmt.Errorf("riders: hset location %s: %w", key, err)
	}
	if err := c.Expire(ctx, key, locationTTL).Err(); err != nil {
		return fmt.Errorf("riders: expire location %s: %w", key, err)
	}
	return nil
}

// GetLocation reads the stored rider position back. It is used by tests and
// by callers that need the freshest position without a full scan.
func (o *OnlineRegistry) GetLocation(ctx context.Context, riderID uuid.UUID) (lat, lon float64, at time.Time, err error) {
	if o.r == nil || o.r.Client() == nil {
		return 0, 0, time.Time{}, errors.New("riders: online registry requires Redis")
	}
	key := locationKey(riderID)
	vals, err := o.r.Client().HMGet(ctx, key, "lat", "lon", "at").Result()
	if err != nil {
		return 0, 0, time.Time{}, fmt.Errorf("riders: hmget location %s: %w", key, err)
	}
	if vals[0] == nil || vals[1] == nil || vals[2] == nil {
		return 0, 0, time.Time{}, ErrLocationNotFound
	}
	lat, err = strconv.ParseFloat(vals[0].(string), 64)
	if err != nil {
		return 0, 0, time.Time{}, fmt.Errorf("riders: parse lat: %w", err)
	}
	lon, err = strconv.ParseFloat(vals[1].(string), 64)
	if err != nil {
		return 0, 0, time.Time{}, fmt.Errorf("riders: parse lon: %w", err)
	}
	at, err = time.Parse(time.RFC3339, vals[2].(string))
	if err != nil {
		return 0, 0, time.Time{}, fmt.Errorf("riders: parse location timestamp: %w", err)
	}
	return lat, lon, at, nil
}

// IsOnline reports whether the rider is currently a member of the online
// set (ZSCORE). A rider that never went online, or whose entry was removed,
// is offline. Dispatch uses this for the manual-override availability gate.
func (o *OnlineRegistry) IsOnline(ctx context.Context, riderID uuid.UUID) (bool, error) {
	if o.r == nil || o.r.Client() == nil {
		return false, errors.New("riders: online registry requires Redis")
	}
	key := riderID.String()
	_, err := o.r.Client().ZScore(ctx, onlineSetKey, key).Result()
	if errors.Is(err, redis.Nil) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("riders: zscore online %s: %w", key, err)
	}
	return true, nil
}

// OnlineRiderIDs returns the ids of every rider currently in the online
// set (ZRANGE 0 -1). Dispatch auto-matching reads this set as the
// authoritative pool of available riders; members are rider id strings.
func (o *OnlineRegistry) OnlineRiderIDs(ctx context.Context) ([]uuid.UUID, error) {
	if o.r == nil || o.r.Client() == nil {
		return nil, errors.New("riders: online registry requires Redis")
	}
	members, err := o.r.Client().ZRange(ctx, onlineSetKey, 0, -1).Result()
	if err != nil {
		return nil, fmt.Errorf("riders: zrange online: %w", err)
	}
	ids := make([]uuid.UUID, 0, len(members))
	for _, m := range members {
		id, err := uuid.Parse(m)
		if err != nil {
			return nil, fmt.Errorf("riders: parse online member %q: %w", m, err)
		}
		ids = append(ids, id)
	}
	return ids, nil
}

// Count returns the number of riders currently in the online set.
func (o *OnlineRegistry) Count(ctx context.Context) (int64, error) {
	if o.r == nil || o.r.Client() == nil {
		return 0, errors.New("riders: online registry requires Redis")
	}
	n, err := o.r.Client().ZCard(ctx, onlineSetKey).Result()
	if err != nil {
		return 0, fmt.Errorf("riders: zcard online: %w", err)
	}
	return n, nil
}

func locationKey(riderID uuid.UUID) string {
	return "rider:loc:" + riderID.String()
}
