// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package terminal

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync"
	"time"
)

type Manager struct {
	mu sync.Mutex
	// sessions: terminal_session_id → managed wrapper handle.
	sessions map[string]managedSession
	// sidIndex: claude session_id (current OR historical) → ExternalSession.
	// Populated/updated by the rebind listener wired in RegisterExternal.
	// Includes drifted (prior) sids so the inject path can report drift
	// instead of 404 — Manager.LookupExternalForInject inspects ext.
	// ClaudeSessionID() to distinguish current vs drifted.
	sidIndex map[string]*ExternalSession
}

type managedSession struct {
	session   SessionHandle
	external  *ExternalSession
	createdAt time.Time
}

type SessionHandle interface {
	Events() <-chan Event
	Status() (SessionStatus, TurnStatus)
	Subscribe(buffer int) (<-chan Event, func())
	SendInput(text string) error
	SendRaw(text string) error
	Resize(cols, rows uint16) error
	Stop() error
	Wait()
}

type Summary struct {
	ID            string        `json:"id"`
	SessionStatus SessionStatus `json:"session_status"`
	TurnStatus    TurnStatus    `json:"turn_status"`
	CreatedAt     time.Time     `json:"created_at"`
	// ClaudeSessionID is "" until the wrapper's discoverSessionIDFromProjectsDir
	// fires and BindSessionMetadata stamps it. Exposed in the local API so
	// e2e debuggers can see exactly when the binding lands without having
	// to instrument the wrapper or daemon with extra logging.
	ClaudeSessionID string `json:"claude_session_id,omitempty"`
	Cwd             string `json:"cwd,omitempty"`
	// Driver names which agent driver owns this session: "pty" (wrapper)
	// or "sdk" (daemon-spawned `claude --resume` headless). Empty
	// defaults to "pty" at the relay. Consumed by the daemon's
	// reconnect re-announce loop so SDK-driven keepalives get tagged
	// correctly in terminal_sessions.
	Driver string `json:"driver,omitempty"`
	// LastActivity is internal/debug visibility for stale external terminal
	// cleanup. It is refreshed by wrapper keepalives and terminal events.
	LastActivity time.Time `json:"last_activity,omitempty"`
}

func NewManager() *Manager {
	return &Manager{
		sessions: map[string]managedSession{},
		sidIndex: map[string]*ExternalSession{},
	}
}

func (m *Manager) Create(ctx context.Context, cfg LaunchConfig) (string, *Session, error) {
	return m.CreateWithID(ctx, "ts_"+randomHex(12), cfg)
}

func (m *Manager) CreateWithID(ctx context.Context, id string, cfg LaunchConfig) (string, *Session, error) {
	session, err := Start(ctx, cfg)
	if err != nil {
		return "", nil, err
	}
	m.mu.Lock()
	m.sessions[id] = managedSession{session: session, createdAt: time.Now().UTC()}
	m.mu.Unlock()
	go func() {
		session.Wait()
		m.mu.Lock()
		delete(m.sessions, id)
		m.mu.Unlock()
	}()
	return id, session, nil
}

func (m *Manager) RegisterExternal(id string) (string, *ExternalSession, error) {
	if id == "" {
		id = "ts_" + randomHex(12)
	}
	session := NewExternalSession()
	m.mu.Lock()
	if _, exists := m.sessions[id]; exists {
		m.mu.Unlock()
		return "", nil, fmt.Errorf("terminal session already exists")
	}
	m.sessions[id] = managedSession{session: session, external: session, createdAt: time.Now().UTC()}
	m.mu.Unlock()
	// Wire the rebind listener so the manager's sidIndex stays current as
	// the wrapper rotates jsonls. Prior sids stay in the index pointing at
	// the same ext so LookupExternalForInject can detect drift instead of
	// a confusing 404.
	session.SetRebindListener(func(prev, current string) {
		m.mu.Lock()
		if current != "" {
			m.sidIndex[current] = session
		}
		// Keep prev sids in the index — they're "drifted" anchors that
		// resolve to the same live ext so callers can compare against
		// ext.ClaudeSessionID() and report drift.
		if prev != "" {
			m.sidIndex[prev] = session
		}
		m.mu.Unlock()
	})
	go func() {
		session.Wait()
		m.mu.Lock()
		delete(m.sessions, id)
		// Purge sidIndex entries that point at this dead ext. We can't
		// rely on the ext's own sid list because rebinds drop into a
		// closed listener once Wait returns.
		for sid, e := range m.sidIndex {
			if e == session {
				delete(m.sidIndex, sid)
			}
		}
		m.mu.Unlock()
	}()
	return id, session, nil
}

func (m *Manager) Get(id string) (SessionHandle, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	managed, ok := m.sessions[id]
	return managed.session, ok
}

func (m *Manager) GetExternal(id string) (*ExternalSession, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	managed, ok := m.sessions[id]
	return managed.external, ok && managed.external != nil
}

// FindExternalBySessionID returns the live wrapper-backed terminal whose
// CURRENT Claude session_id matches. Returns (nil, false) when the sid is
// unknown OR when it's a known-but-drifted prior sid (use
// LookupExternalForInject to distinguish those cases).
func (m *Manager) FindExternalBySessionID(sessionID string) (*ExternalSession, bool) {
	if sessionID == "" {
		return nil, false
	}
	m.mu.Lock()
	ext := m.sidIndex[sessionID]
	m.mu.Unlock()
	if ext == nil {
		return nil, false
	}
	if ext.ClaudeSessionID() != sessionID {
		return nil, false
	}
	status, _ := ext.Status()
	if status != SessionLive && status != SessionStarting {
		return nil, false
	}
	return ext, true
}

// InjectLookup is the result of LookupExternalForInject. Ext is the live
// wrapper to route to (nil if none); Drifted=true means the requested sid
// is a known prior sid of Ext, and CurrentSID names where Ext is bound
// now — callers should surface that to the user as session_drifted so
// they can confirm continuing on the new sid (or stop sending into the
// wrong jsonl, which is what would happen if we silently misrouted).
type InjectLookup struct {
	Ext        *ExternalSession
	Drifted    bool
	CurrentSID string
}

// LookupExternalForInject resolves a sid → live external + drift info.
// Three outcomes:
//   - exact match on current sid: Drifted=false, Ext non-nil
//   - match on a prior sid of a still-live ext: Drifted=true, Ext non-nil,
//     CurrentSID points at the now-active sid
//   - no live ext owns this sid (current or prior): Ext nil
func (m *Manager) LookupExternalForInject(sessionID string) InjectLookup {
	if sessionID == "" {
		return InjectLookup{}
	}
	m.mu.Lock()
	ext := m.sidIndex[sessionID]
	m.mu.Unlock()
	if ext == nil {
		return InjectLookup{}
	}
	status, _ := ext.Status()
	if status != SessionLive && status != SessionStarting {
		return InjectLookup{}
	}
	current := ext.ClaudeSessionID()
	if current == sessionID {
		return InjectLookup{Ext: ext, CurrentSID: current}
	}
	return InjectLookup{Ext: ext, Drifted: true, CurrentSID: current}
}

func (m *Manager) List() []Summary {
	m.mu.Lock()
	candidates := make([]struct {
		id        string
		createdAt time.Time
		session   SessionHandle
		external  *ExternalSession
	}, 0, len(m.sessions))
	for id, managed := range m.sessions {
		candidates = append(candidates, struct {
			id        string
			createdAt time.Time
			session   SessionHandle
			external  *ExternalSession
		}{id, managed.createdAt, managed.session, managed.external})
	}
	m.mu.Unlock()

	// Release Manager.mu before calling into each session — Status() and
	// ClaudeSessionID() take ExternalSession's own mutex; calling them
	// while holding Manager.mu invites cross-lock contention.
	out := make([]Summary, 0, len(candidates))
	for _, c := range candidates {
		sessionStatus, turnStatus := c.session.Status()
		s := Summary{
			ID:            c.id,
			SessionStatus: sessionStatus,
			TurnStatus:    turnStatus,
			CreatedAt:     c.createdAt,
		}
		if c.external != nil {
			s.ClaudeSessionID = c.external.ClaudeSessionID()
			s.Cwd = c.external.Cwd()
			s.Driver = c.external.Driver()
			s.LastActivity = c.external.LastActivity()
		}
		out = append(out, s)
	}
	return out
}

func (m *Manager) ReapStalePTYExternal(maxIdle time.Duration, now time.Time) []Summary {
	if maxIdle <= 0 {
		return nil
	}
	type victim struct {
		id        string
		createdAt time.Time
		ext       *ExternalSession
	}
	var victims []victim
	m.mu.Lock()
	for id, managed := range m.sessions {
		ext := managed.external
		if ext == nil {
			continue
		}
		driver := ext.Driver()
		if driver != "" && driver != "pty" {
			continue
		}
		status, _ := ext.Status()
		if status != SessionLive && status != SessionStarting {
			continue
		}
		last := ext.LastActivity()
		if last.IsZero() || now.Sub(last) <= maxIdle {
			continue
		}
		victims = append(victims, victim{id: id, createdAt: managed.createdAt, ext: ext})
	}
	m.mu.Unlock()

	out := make([]Summary, 0, len(victims))
	for _, v := range victims {
		status, turn := v.ext.Status()
		out = append(out, Summary{
			ID:              v.id,
			SessionStatus:   status,
			TurnStatus:      turn,
			CreatedAt:       v.createdAt,
			ClaudeSessionID: v.ext.ClaudeSessionID(),
			Cwd:             v.ext.Cwd(),
			Driver:          v.ext.Driver(),
			LastActivity:    v.ext.LastActivity(),
		})
		_ = v.ext.Stop()
		m.mu.Lock()
		if managed, ok := m.sessions[v.id]; ok && managed.external == v.ext {
			delete(m.sessions, v.id)
		}
		for sid, ext := range m.sidIndex {
			if ext == v.ext {
				delete(m.sidIndex, sid)
			}
		}
		m.mu.Unlock()
	}
	return out
}

func (m *Manager) SendInput(id, text string) error {
	session, ok := m.Get(id)
	if !ok {
		return fmt.Errorf("terminal session not found")
	}
	return session.SendInput(text)
}

func (m *Manager) SendRaw(id, text string) error {
	session, ok := m.Get(id)
	if !ok {
		return fmt.Errorf("terminal session not found")
	}
	return session.SendRaw(text)
}

func (m *Manager) Resize(id string, cols, rows uint16) error {
	session, ok := m.Get(id)
	if !ok {
		return fmt.Errorf("terminal session not found")
	}
	return session.Resize(cols, rows)
}

func (m *Manager) Stop(id string) error {
	session, ok := m.Get(id)
	if !ok {
		return nil
	}
	return session.Stop()
}

func randomHex(n int) string {
	buf := make([]byte, n)
	if _, err := rand.Read(buf); err != nil {
		return "fallback"
	}
	return hex.EncodeToString(buf)
}
