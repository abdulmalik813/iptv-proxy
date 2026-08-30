package stream

import (
	"context"
	"io"
	"net/http"
	"sync/atomic"
	"testing"
	"time"
)

func TestManagerSharesOneUpstreamAcrossViewers(t *testing.T) {
	manager := NewManager()
	reader, writer := io.Pipe()
	var opens atomic.Int32

	open := func(context.Context) (*http.Response, error) {
		opens.Add(1)
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     http.Header{"Content-Type": []string{"video/mp2t"}},
			Body:       reader,
		}, nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	session1, viewer1, err := manager.Subscribe(ctx, "provider:live:101.ts", open)
	if err != nil {
		t.Fatal(err)
	}
	session2, viewer2, err := manager.Subscribe(ctx, "provider:live:101.ts", open)
	if err != nil {
		t.Fatal(err)
	}
	if session1 != session2 {
		t.Fatal("expected both viewers to share the same session")
	}
	if got := opens.Load(); got != 1 {
		t.Fatalf("expected one upstream connection, got %d", got)
	}

	payload := []byte("mpeg-ts-payload")
	if _, err := writer.Write(payload); err != nil {
		t.Fatal(err)
	}

	for i, viewer := range []*Viewer{viewer1, viewer2} {
		chunk, err := viewer.Next(ctx)
		if err != nil {
			t.Fatalf("viewer %d: %v", i+1, err)
		}
		if string(chunk) != string(payload) {
			t.Fatalf("viewer %d received %q", i+1, chunk)
		}
	}

	session1.Remove(viewer1)
	session1.Remove(viewer2)
	_ = writer.Close()

	select {
	case <-session1.WaitDone():
	case <-ctx.Done():
		t.Fatal("session did not stop after last viewer disconnected")
	}
}

func TestManagerRejectsFailedUpstream(t *testing.T) {
	manager := NewManager()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	_, _, err := manager.Subscribe(ctx, "provider:live:500.ts", func(context.Context) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusForbidden,
			Header:     make(http.Header),
			Body:       io.NopCloser(&emptyReader{}),
		}, nil
	})
	if err == nil {
		t.Fatal("expected upstream HTTP failure")
	}
}

type emptyReader struct{}

func (*emptyReader) Read([]byte) (int, error) { return 0, io.EOF }
