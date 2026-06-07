// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package terminal

import (
	"errors"
	"strings"
	"sync"
	"time"
)

// ExitIntent captures the wrapper's classification of its own exit,
// reported via POST /api/dev/terminal-sessions/<id>/exit-intent right
// before the wrapper process actually exits. Daemon-side recovery
// logic reads this to decide whether to skip resurrection (user
// pressed Ctrl+C → clean) vs spawn an SDK driver (claude crashed →
// unclean) when the keepalive timer eventually flips the session.
type ExitIntent struct {
	Clean           bool      `json:"clean"`
	UserInitiated   bool      `json:"user_initiated"`
	ExitCode        int       `json:"exit_code"`
	TerminatedBy    string    `json:"terminated_by,omitempty"`
	ReportedFromPID int       `json:"reported_from_pid,omitempty"`
	At              time.Time `json:"at"`
}

type ExternalSession struct {
	mu              sync.Mutex
	events          chan Event
	subscribers     map[int]chan Event
	nextSubID       int
	inputs          map[int]chan string
	nextInputID     int
	done            chan struct{}
	seq             int64
	sessionStatus   SessionStatus
	turnStatus      TurnStatus
	stopped         bool
	eventsClosed    bool
	claudeSessionID string // current sid; mutates whenever the wrapper rotates jsonls (e.g. in-app /resume)
	priorSessionIDs []string
	cwd             string
	claudePID       int
	driver          string                     // "pty" (default) or "sdk"; surfaced in Manager.List()
	rebindListener  func(prev, current string) // optional; invoked under no lock for rebind notifications
	exitIntent      *ExitIntent                // nil until wrapper POSTs /exit-intent; pointer so "no report yet" is distinguishable from "reported clean=false"
	lastActivity    time.Time
}

func NewExternalSession() *ExternalSession {
	now := time.Now().UTC()
	s := &ExternalSession{
		events:        make(chan Event, 128),
		subscribers:   map[int]chan Event{},
		inputs:        map[int]chan string{},
		done:          make(chan struct{}),
		sessionStatus: SessionLive,
		turnStatus:    TurnAwaitingInput,
		lastActivity:  now,
	}
	s.Emit(EventSessionStarted, SessionLive, TurnAwaitingInput, "", "")
	s.Emit(EventSessionReady, SessionLive, TurnAwaitingInput, "", "")
	return s
}

// Seq returns the current monotonic event sequence (the seq of the most
// recently emitted event). The SDK manager reads this before an idle
// session's ExternalSession is dropped, so the next re-created session
// can continue above it.
func (s *ExternalSession) Seq() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.seq
}

// InputSubscriberCount reports how many active SendInput subscribers exist.
// Tests use it to assert that a dead subprocess's pumpStdin goroutine drops
// its subscription — otherwise a reuse-respawn ends up with two stdin pumps
// and SendInput broadcasts the next prompt to both, losing it to the dead one.
func (s *ExternalSession) InputSubscriberCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.inputs)
}

// SeedSeq raises the event sequence so the NEXT emitted event gets a seq
// strictly greater than n (no-op if n is at or below the current seq).
// Nexus keys turns on (session, seq); when an idle SDK driver is
// reaped and later re-created for a follow-up turn, a fresh
// ExternalSession would otherwise restart seq from 0 and the follow-up's
// turns would collide with — and overwrite — the original turn's rows.
// Seeding from the prior instance's high-water keeps seqs monotonic
// across re-creation.
func (s *ExternalSession) SeedSeq(n int64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if n > s.seq {
		s.seq = n
	}
}

func (s *ExternalSession) Events() <-chan Event {
	return s.events
}

func (s *ExternalSession) Status() (SessionStatus, TurnStatus) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sessionStatus, s.turnStatus
}

func (s *ExternalSession) Subscribe(buffer int) (<-chan Event, func()) {
	if buffer <= 0 {
		buffer = 128
	}
	ch := make(chan Event, buffer)
	s.mu.Lock()
	if s.stopped || s.sessionStatus == SessionExited || s.sessionStatus == SessionError {
		s.mu.Unlock()
		close(ch)
		return ch, func() {}
	}
	id := s.nextSubID
	s.nextSubID++
	s.subscribers[id] = ch
	s.mu.Unlock()
	return ch, func() {
		s.mu.Lock()
		sub, ok := s.subscribers[id]
		if ok {
			delete(s.subscribers, id)
		}
		s.mu.Unlock()
		if ok {
			close(sub)
		}
	}
}

func (s *ExternalSession) SubscribeInput(buffer int) (<-chan string, func()) {
	if buffer <= 0 {
		buffer = 32
	}
	ch := make(chan string, buffer)
	s.mu.Lock()
	if s.stopped || s.sessionStatus == SessionExited || s.sessionStatus == SessionError {
		s.mu.Unlock()
		close(ch)
		return ch, func() {}
	}
	id := s.nextInputID
	s.nextInputID++
	s.inputs[id] = ch
	s.mu.Unlock()
	return ch, func() {
		s.mu.Lock()
		input, ok := s.inputs[id]
		if ok {
			delete(s.inputs, id)
		}
		s.mu.Unlock()
		if ok {
			close(input)
		}
	}
}

func (s *ExternalSession) SendInput(text string) error {
	text = strings.TrimRight(text, "\r\n")
	if strings.TrimSpace(text) == "" {
		return errors.New("text is required")
	}
	s.mu.Lock()
	if s.stopped || s.sessionStatus == SessionExited || s.sessionStatus == SessionError {
		s.mu.Unlock()
		return errors.New("terminal session is not live")
	}
	s.lastActivity = time.Now().UTC()
	s.turnStatus = TurnSubmitted
	s.mu.Unlock()
	// Emit re-acquires s.mu, so it must run with the lock released. Slash
	// commands are control-plane input (for example agent-settings sends
	// "/model haiku") and should not render as user chat bubbles.
	if !isSlashCommandInput(text) {
		s.Emit(EventUserInput, SessionLive, TurnSubmitted, text, "")
	}
	// Deliver under the lock so a concurrent close() (which clears s.inputs and
	// closes those channels under the same lock) can't close a channel mid-send.
	// EventUserInput isn't a terminal kind so the Emit above never closes the
	// session itself, but a concurrent close() may have — re-check eventsClosed.
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.eventsClosed {
		return nil
	}
	for _, ch := range s.inputs {
		select {
		case ch <- text + "\r":
		default:
		}
	}
	return nil
}

func isSlashCommandInput(text string) bool {
	t := strings.TrimSpace(text)
	if !strings.HasPrefix(t, "/") {
		return false
	}
	first := t
	if i := strings.IndexAny(t, " \t"); i >= 0 {
		first = t[:i]
	}
	if len(first) < 2 {
		return false
	}
	for i, r := range first[1:] {
		switch {
		case i == 0 && (r < 'a' || r > 'z'):
			return false
		case r >= 'a' && r <= 'z':
		case r >= '0' && r <= '9':
		case r == '-' || r == '_' || r == ':':
		default:
			return false
		}
	}
	return true
}

func (s *ExternalSession) SendRaw(text string) error {
	if text == "" {
		return nil
	}
	// Deliver under the lock (see SendInput/Emit) so a concurrent close() — which
	// clears s.inputs and closes those channels under the same lock — can't close
	// a channel mid-send. Sends are non-blocking (select/default).
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopped || s.sessionStatus == SessionExited || s.sessionStatus == SessionError {
		return errors.New("terminal session is not live")
	}
	s.lastActivity = time.Now().UTC()
	for _, ch := range s.inputs {
		select {
		case ch <- text:
		default:
		}
	}
	return nil
}

func (s *ExternalSession) Resize(_, _ uint16) error {
	return nil
}

// BindSessionMetadata records the Claude session_id and cwd reported by
// the wrapper alongside one of its events. Mutates on every non-empty
// sessionID — the wrapper's watchActiveSessionID polls the child's open
// jsonl fd continuously, so a new sid means claude has rotated jsonls
// (in-app /resume, /clear, /new etc.). Previously this latched the first
// non-empty value, which silently routed inject text to the wrong jsonl
// after any rotation. We keep prior sids in priorSessionIDs so the
// manager can detect drift on inject and surface it to the web instead
// of either 404'ing or silently misrouting.
//
// Returns (prev, changed) so callers can decide whether to notify
// downstream systems about the change. Callers that don't care about the
// transition can ignore the return.
func (s *ExternalSession) BindSessionMetadata(sessionID, cwd string) (prev string, changed bool) {
	s.mu.Lock()
	listener := s.rebindListener
	if sessionID != "" || cwd != "" {
		s.lastActivity = time.Now().UTC()
	}
	if sessionID != "" && sessionID != s.claudeSessionID {
		prev = s.claudeSessionID
		if prev != "" {
			s.priorSessionIDs = append(s.priorSessionIDs, prev)
		}
		s.claudeSessionID = sessionID
		changed = true
	}
	if cwd != "" && s.cwd == "" {
		s.cwd = cwd
	}
	current := s.claudeSessionID
	s.mu.Unlock()
	if changed && listener != nil {
		listener(prev, current)
	}
	return prev, changed
}

// SetRebindListener registers a callback that fires whenever
// BindSessionMetadata observes a sid change. The Manager uses this to
// keep its sid→ext reverse index current. Listener runs with no
// ExternalSession lock held, so it's safe for it to call back into other
// ExternalSession methods. Calling SetRebindListener replaces any
// previously registered listener.
func (s *ExternalSession) SetRebindListener(fn func(prev, current string)) {
	s.mu.Lock()
	s.rebindListener = fn
	s.mu.Unlock()
}

// RecordExitIntent stashes the wrapper's classification of its own
// exit. Pointer storage so a later LastExitIntent() can distinguish
// "no report yet" (wrapper still running, or killed via SIGKILL with
// no chance to POST) from "reported clean=false" (claude crashed and
// wrapper had time to say so).
func (s *ExternalSession) RecordExitIntent(intent ExitIntent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Snapshot the value so the caller can mutate their copy without
	// racing this struct.
	copy := intent
	s.exitIntent = &copy
}

// LastExitIntent returns the most recent exit intent the wrapper
// reported, or nil if it hasn't reported one. Recovery logic checks
// this on the keepalive-loss code path: nil → assume unclean (wrapper
// died silently); non-nil + Clean=false → confirmed crash; non-nil +
// Clean=true → user-initiated, skip recovery.
func (s *ExternalSession) LastExitIntent() *ExitIntent {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.exitIntent == nil {
		return nil
	}
	copy := *s.exitIntent
	return &copy
}

// BindPID records the claude child PID the wrapper spawned. The daemon's
// inject-time verification (gate 3) uses this to re-scan the child's
// open fds before routing text to its PTY, catching cases where the
// wrapper's last-sent sid has gone stale by the time the inject lands.
func (s *ExternalSession) BindPID(pid int) {
	if pid <= 0 {
		return
	}
	s.mu.Lock()
	s.claudePID = pid
	s.mu.Unlock()
}

// ClaudeSessionID returns the Claude session_id this terminal is currently
// bound to, or "" if the wrapper hasn't reported one yet.
func (s *ExternalSession) ClaudeSessionID() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.claudeSessionID
}

// PriorSessionIDs returns a copy of the historical sids this terminal has
// been bound to, in rotation order. The most recent prior is the last
// element. Used by the daemon to attribute "drift" injects (web targets
// an old sid) to the still-live terminal that owns its successor.
func (s *ExternalSession) PriorSessionIDs() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.priorSessionIDs) == 0 {
		return nil
	}
	out := make([]string, len(s.priorSessionIDs))
	copy(out, s.priorSessionIDs)
	return out
}

// ClaudePID returns the wrapper's child PID, or 0 if not yet reported.
func (s *ExternalSession) ClaudePID() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.claudePID
}

func (s *ExternalSession) Touch() {
	s.mu.Lock()
	if !s.stopped && s.sessionStatus != SessionExited && s.sessionStatus != SessionError {
		s.lastActivity = time.Now().UTC()
	}
	s.mu.Unlock()
}

func (s *ExternalSession) LastActivity() time.Time {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.lastActivity
}

// Cwd returns the working directory the wrapper was launched in.
func (s *ExternalSession) Cwd() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cwd
}

// Driver returns the driver name ("pty" or "sdk") that owns this
// session. Empty defaults to "pty" — set explicitly via SetDriver when
// the daemon's SDK headless driver registers a session, so the
// reconnect re-announce loop tags keepalives correctly.
func (s *ExternalSession) Driver() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.driver
}

// SetDriver records which agent driver owns this session. Called by
// sdkdriver right after Manager.RegisterExternal returns; the wrapper
// path leaves it empty (and Nexus defaults empty to "pty").
func (s *ExternalSession) SetDriver(driver string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.driver = driver
}

func (s *ExternalSession) Stop() error {
	s.Emit(EventSessionExited, SessionExited, TurnIdle, "", "")
	s.close()
	return nil
}

func (s *ExternalSession) Wait() {
	<-s.done
}

func (s *ExternalSession) Emit(kind EventKind, sessionStatus SessionStatus, turnStatus TurnStatus, payload, errorText string) {
	s.mu.Lock()
	if s.eventsClosed {
		s.mu.Unlock()
		return
	}
	s.lastActivity = time.Now().UTC()
	s.seq++
	if sessionStatus != "" {
		s.sessionStatus = sessionStatus
	}
	if turnStatus != "" {
		s.turnStatus = turnStatus
	}
	event := Event{
		Seq:           s.seq,
		Kind:          kind,
		SessionStatus: s.sessionStatus,
		TurnStatus:    s.turnStatus,
		Payload:       payload,
		Error:         errorText,
		Timestamp:     time.Now().UTC(),
	}
	// Deliver while still holding s.mu. close() clears s.subscribers/s.inputs and
	// closes those channels under the same lock, so delivering here can't race a
	// close that shuts a channel mid-send. Every send is non-blocking
	// (select/default), so holding the lock during delivery never blocks. The
	// previous snapshot-then-send-after-unlock raced close() and panicked with
	// "send on closed channel" — and with no recover() anywhere in the daemon,
	// that crashed the whole process (taking down every other live session).
	select {
	case s.events <- event:
	default:
	}
	for _, ch := range s.subscribers {
		select {
		case ch <- event:
		default:
		}
	}
	terminal := kind == EventSessionExited || kind == EventError
	s.mu.Unlock()
	if terminal {
		s.close()
	}
}

func (s *ExternalSession) close() {
	s.mu.Lock()
	if s.eventsClosed {
		s.mu.Unlock()
		return
	}
	s.stopped = true
	s.eventsClosed = true
	eventSubscribers := make([]chan Event, 0, len(s.subscribers))
	for _, ch := range s.subscribers {
		eventSubscribers = append(eventSubscribers, ch)
	}
	inputSubscribers := make([]chan string, 0, len(s.inputs))
	for _, ch := range s.inputs {
		inputSubscribers = append(inputSubscribers, ch)
	}
	s.subscribers = map[int]chan Event{}
	s.inputs = map[int]chan string{}
	close(s.done)
	close(s.events)
	s.mu.Unlock()

	for _, ch := range eventSubscribers {
		close(ch)
	}
	for _, ch := range inputSubscribers {
		close(ch)
	}
}
