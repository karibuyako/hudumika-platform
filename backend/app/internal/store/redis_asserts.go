package store

// Compile-time interface conformance for the Redis backends.
var _ OtpStore = (*otpRedisStores)(nil)
var _ RateLimiter = (*otpRedisStores)(nil)
var _ SessionStore = (*sessionRedisStores)(nil)
var _ IdempotencyStore = (*idempotencyRedisStores)(nil)
