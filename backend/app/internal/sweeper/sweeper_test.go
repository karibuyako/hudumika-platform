package sweeper

import (
	"testing"

	"github.com/google/uuid"
)

// Unit tests for the DB-free helpers of the sweeper package. The jobs
// themselves need a real database and live in sweeper_integration_test.go
// behind the integration build tag.

func TestBatchIDsEmpty(t *testing.T) {
	if got := batchIDs(nil, eventBatch); len(got) != 0 {
		t.Fatalf("batchIDs(nil) = %v, want empty", got)
	}
}

func TestBatchIDsSplitsOnSize(t *testing.T) {
	ids := make([]uuid.UUID, 25)
	for i := range ids {
		ids[i] = uuid.New()
	}
	batches := batchIDs(ids, 10)
	if len(batches) != 3 {
		t.Fatalf("got %d batches, want 3", len(batches))
	}
	for i, want := range []int{10, 10, 5} {
		if len(batches[i]) != want {
			t.Fatalf("batch %d has %d ids, want %d", i, len(batches[i]), want)
		}
	}
	var merged []uuid.UUID
	for _, b := range batches {
		merged = append(merged, b...)
	}
	for i, id := range ids {
		if merged[i] != id {
			t.Fatalf("batch %d = %s, want %s", i, merged[i], id)
		}
	}
}

func TestBatchIDsExactMultiple(t *testing.T) {
	ids := make([]uuid.UUID, 20)
	for i := range ids {
		ids[i] = uuid.New()
	}
	batches := batchIDs(ids, 10)
	if len(batches) != 2 {
		t.Fatalf("got %d batches, want 2", len(batches))
	}
	for i, b := range batches {
		if len(b) != 10 {
			t.Fatalf("batch %d has %d ids, want 10", i, len(b))
		}
	}
}

func TestBatchIDsFallsBackOnBadSize(t *testing.T) {
	ids := make([]uuid.UUID, 10)
	for i := range ids {
		ids[i] = uuid.New()
	}
	batches := batchIDs(ids, 0)
	if len(batches) != 1 {
		t.Fatalf("got %d batches, want 1", len(batches))
	}
	if len(batches[0]) != 10 {
		t.Fatalf("batch has %d ids, want 10", len(batches[0]))
	}
}
