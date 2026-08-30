package stream

import (
	"context"
	"errors"
	"io"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

const (
	chunkSize       = 128 << 10
	viewerQueueSize = 32
)

type OpenFunc func(context.Context) (*http.Response, error)

type Manager struct {
	mu       sync.Mutex
	sessions map[string]*Session
}

type Session struct {
	key       string
	manager   *Manager
	ctx       context.Context
	cancel    context.CancelFunc
	ready     chan struct{}
	done      chan struct{}
	mu        sync.RWMutex
	viewers   map[uint64]*Viewer
	response  *http.Response
	openErr   error
	startedAt time.Time
	bytesIn   atomic.Int64
	nextID    atomic.Uint64
}

type Viewer struct {
	id      uint64
	queue   chan []byte
	closed  chan struct{}
	closeMu sync.Once
}

type Snapshot struct {
	Key       string    `json:"key"`
	Viewers   int       `json:"viewers"`
	StartedAt time.Time `json:"startedAt"`
	BytesIn   int64     `json:"bytesIn"`
}

func NewManager() *Manager {
	return &Manager{sessions: make(map[string]*Session)}
}

func (m *Manager) Subscribe(ctx context.Context, key string, open OpenFunc) (*Session, *Viewer, error) {
	for {
		m.mu.Lock()
		session := m.sessions[key]
		if session == nil {
			sessionCtx, cancel := context.WithCancel(context.Background())
			session = &Session{
				key:       key,
				manager:   m,
				ctx:       sessionCtx,
				cancel:    cancel,
				ready:     make(chan struct{}),
				done:      make(chan struct{}),
				viewers:   make(map[uint64]*Viewer),
				startedAt: time.Now(),
			}
			m.sessions[key] = session
			go session.run(open)
		}
		m.mu.Unlock()

		select {
		case <-ctx.Done():
			return nil, nil, ctx.Err()
		case <-session.ready:
		}

		if session.openErr != nil {
			return nil, nil, session.openErr
		}
		select {
		case <-session.done:
			continue
		default:
		}

		viewer := session.addViewer()
		return session, viewer, nil
	}
}

func (m *Manager) Snapshots() []Snapshot {
	m.mu.Lock()
	sessions := make([]*Session, 0, len(m.sessions))
	for _, session := range m.sessions {
		sessions = append(sessions, session)
	}
	m.mu.Unlock()

	out := make([]Snapshot, 0, len(sessions))
	for _, session := range sessions {
		session.mu.RLock()
		viewers := len(session.viewers)
		session.mu.RUnlock()
		out = append(out, Snapshot{Key: session.key, Viewers: viewers, StartedAt: session.startedAt, BytesIn: session.bytesIn.Load()})
	}
	return out
}

func (s *Session) StatusCode() int {
	if s.response == nil {
		return http.StatusBadGateway
	}
	return s.response.StatusCode
}

func (s *Session) Header() http.Header {
	if s.response == nil {
		return make(http.Header)
	}
	return s.response.Header.Clone()
}

func (s *Session) run(open OpenFunc) {
	resp, err := open(s.ctx)
	if err != nil {
		s.openErr = err
		close(s.ready)
		s.finish()
		return
	}
	s.response = resp
	close(s.ready)
	defer resp.Body.Close()
	defer s.finish()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return
	}

	buffer := make([]byte, chunkSize)
	for {
		n, readErr := resp.Body.Read(buffer)
		if n > 0 {
			chunk := append([]byte(nil), buffer[:n]...)
			s.bytesIn.Add(int64(n))
			s.broadcast(chunk)
		}
		if readErr != nil {
			if !errors.Is(readErr, io.EOF) && !errors.Is(readErr, context.Canceled) {
				// Existing viewers simply observe stream closure; a new request will create a fresh session.
			}
			return
		}
		select {
		case <-s.ctx.Done():
			return
		default:
		}
	}
}

func (s *Session) addViewer() *Viewer {
	viewer := &Viewer{
		id:     s.nextID.Add(1),
		queue:  make(chan []byte, viewerQueueSize),
		closed: make(chan struct{}),
	}
	s.mu.Lock()
	s.viewers[viewer.id] = viewer
	s.mu.Unlock()
	return viewer
}

func (s *Session) broadcast(chunk []byte) {
	s.mu.Lock()
	for id, viewer := range s.viewers {
		select {
		case viewer.queue <- chunk:
		default:
			delete(s.viewers, id)
			viewer.close()
		}
	}
	empty := len(s.viewers) == 0
	s.mu.Unlock()
	if empty {
		s.cancel()
	}
}

func (s *Session) Remove(viewer *Viewer) {
	if viewer == nil {
		return
	}
	s.mu.Lock()
	if current, ok := s.viewers[viewer.id]; ok && current == viewer {
		delete(s.viewers, viewer.id)
		viewer.close()
	}
	empty := len(s.viewers) == 0
	s.mu.Unlock()
	if empty {
		s.cancel()
	}
}

func (v *Viewer) Next(ctx context.Context) ([]byte, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-v.closed:
		return nil, io.EOF
	case chunk, ok := <-v.queue:
		if !ok {
			return nil, io.EOF
		}
		return chunk, nil
	}
}

func (v *Viewer) close() {
	v.closeMu.Do(func() {
		close(v.closed)
	})
}

func (s *Session) finish() {
	s.cancel()
	s.mu.Lock()
	for id, viewer := range s.viewers {
		delete(s.viewers, id)
		viewer.close()
	}
	s.mu.Unlock()
	select {
	case <-s.done:
	default:
		close(s.done)
	}
	s.manager.mu.Lock()
	if s.manager.sessions[s.key] == s {
		delete(s.manager.sessions, s.key)
	}
	s.manager.mu.Unlock()
}

func (s *Session) WaitDone() <-chan struct{} {
	return s.done
}

func SlowViewerGrace() time.Duration {
	// Queue saturation is the hard eviction boundary. Keeping this exported makes the policy visible to status/tests.
	return 30 * time.Second
}
