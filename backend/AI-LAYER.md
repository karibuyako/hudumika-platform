# HUDumika Backend — AI & ML Layer (Phase 3)

Design for the intelligent layer behind dispatching, routing, pricing, safety,
and proof-of-delivery. Follows the Meituan "Super Brain" pattern at a scale
appropriate to HUDumika — figures like "29B routing requests/hour" or "760B
daily LBS calls" are **long-term capacity targets**, not v1 requirements.

## Models

| Model | Inputs | Output | Used by |
| --- | --- | --- | --- |
| Order–rider matching | acceptance history, location, workload, vehicle, preferences, hub/fleet type | acceptance probability per candidate | `DISPATCH.md` scoring (replaces/augments rule scoring) |
| Merchant prep-time | merchant, items, time-of-day, queue depth, history | `predictedPrepMinutes` | `DispatchOffer`, dispatch timing (assign when nearly ready) |
| Delivery ETA | route features, traffic, weather, rider speed history | `TrackingEvent.stageEtas` (merchant arrival / pickup / dropoff) | tracking, customer updates |
| Demand forecast | historical orders, weather, events, time-of-day | 15-min-ahead zone demand (`GET /dispatch/forecast`) | `PredictiveDemandZone`, rider repositioning |
| Surge pricing | demand-to-supply ratio (predicted) | surge multiplier per zone/window | `FareBreakdown.surgeMultiplier`; RL variant ramps gradually (no abrupt drops) |
| Rider speed/performance | rider history × route characteristics | per-rider speed estimate | ETA + offer estimates |
| Anomaly detection | order/refund/location streams | risk events (`refund_*`, `order_delay`, `rider_inactivity`, `suspicious_cancellation`) | `risk_events`, admin overview |
| Fatigue/crash CV | front camera frames (fatigue), accelerometer/gyroscope/GPS (crash) | `SafetyEvent` (fatigue_detected, crash_detected, fall_detected) | `POST /riders/me/safety-events` → SOS automation |
| POD image verification | delivery photo | quality/accuracy score (on-device, offline) | POD fraud reduction |
| Review sentiment | review text | positive/neutral/negative classification (planned) | moderation + provider feedback |
| Retention risk | engagement, penalties, complaints | retention risk flag per rider | fleet analytics (planned) |
| Document verification | uploaded documents | auto-extract + verify fields (planned) | provider onboarding scale |
| Provider availability prediction | history, schedule, demand | next-available window (planned) | matching + slots |
| Predictive maintenance | usage patterns, vehicle type | maintenance due prediction | fleet ops (planned) |

## Architecture

- **Training**: TensorFlow/PyTorch; retraining pipelines with A/B tests and canary deploys (outcome-based learning from real orders, prep times, ETAs).
- **Inference**: low-latency engines (ONNX Runtime / TensorRT) for millisecond predictions; on-device edge models for CV safety and POD verification (works offline).
- **Feature store**: centralized real-time + historical features (rider location, weather, traffic, order history, merchant prep stats); serves both training and inference.
- **Feedback loops**: customer complaints, rider reports, and GPS trajectories feed model metrics (e.g. heat-map prediction error target ≤ 90 s).
- **Streaming**: Kafka/Flink pipelines for rider locations, order events, and traffic feeds; Redis geospatial for live rider positions.

## Contract integration points

- `GET /dispatch/forecast` — predictive demand zones (confidence + window).
- `DispatchOffer.predictedPrepMinutes` + `addressConfidence` (address disambiguation).
- `TrackingEvent.stageEtas` — per-stage deep-learning ETAs.
- `POST /riders/me/safety-events` — fatigue/crash/threat events; `SafetyEvent` rate-limited; crash escalation per DISPATCH.md.
- `RiderShift.forcedRestUntil` — mandatory rest enforcement; `REST_ENFORCED` blocks new assignments.
- `POST /riders/me/sync/batch` + `GET /riders/me/sync/status` — sequence-numbered offline sync (idempotent, gap detection).
- `GET /admin/fleet/control-tower` — unified fleet view (hubs, regions, fleet types).

## Scale targets (long-term, not v1)

- Millisecond path planning for multi-stop batches (target: sub-ms average per batch of 5).
- Fleet-wide optimization across hundreds of operational variables.
- Multi-region active-active deployment; auto-scaling on demand.
- Signal-light integration and 4D spatiotemporal planning = future platform partnerships, documented for design headroom only.
- High-concurrency backend sized for millions of concurrent riders (long-term target; streaming + sharded dispatch services).
- NLP chat translation and AR-glasses hands-free POD = planned/out-of-scope platform features, kept out of v1.

## Honesty rule

Every model above is either live (contract field exists), planned (documented in
ROADMAP with a milestone), or a long-term target — never presented as built.
