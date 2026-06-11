// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package index

import (
	"context"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"

	"github.com/PocklyApp/Pockly/daemon/internal/agent"
	"github.com/PocklyApp/Pockly/daemon/internal/agent/claude"
	"github.com/PocklyApp/Pockly/daemon/internal/agent/codex"
)

// firstMessageStripPatterns mirror the regexes the web's
// deriveSessionTitle applies. Compiling them once at package init
// keeps the catalog refresh path allocation-free per session.
var firstMessageStripPatterns = []*regexp.Regexp{
	regexp.MustCompile(`(?is)<system-reminder>.*?</system-reminder>`),
	regexp.MustCompile(`(?is)<command-name>.*?</command-name>`),
	regexp.MustCompile(`(?is)<command-args>.*?</command-args>`),
	regexp.MustCompile(`(?is)<command-message>.*?</command-message>`),
	regexp.MustCompile(`(?is)<local-command-stdout>.*?</local-command-stdout>`),
}

const (
	agentClaude = "claude-code"
	agentCodex  = "codex"
)

// Config controls index construction and background refresh.
type Config struct {
	ClaudeHome      string
	CodexHome       string
	RefreshInterval time.Duration
}

// SessionRef is the indexer's lookup record for a concrete session file.
type SessionRef struct {
	Agent string
	Cwd   string
	Path  string
}

// Index maintains a read-optimized in-memory snapshot of local sessions.
//
// Start with a full scan, then keep the snapshot warm with fsnotify plus a
// low-frequency fallback rescan. This eliminates per-request directory walks
// while avoiding silent drift if a watcher event gets dropped or a root did
// not exist at process start.
type Index struct {
	cfg Config

	refreshMu sync.Mutex
	mu        sync.RWMutex
	projects  []agent.Project
	sessions  map[string]SessionRef
	lastScan  time.Time
	lastErr   error
	snapshot  string
	changes   chan struct{}
	// firstMessages caches the cleaned first-user-message snippet per
	// sessionID. The first user message in a session never changes once
	// it's written, so we extract it once and reuse across refreshes
	// (the catalog sync loop ticks every couple seconds, and parsing
	// every JSONL on every tick would be wasteful). Entries for
	// sessions that disappear from the snapshot get GC'd on refresh.
	firstMessages map[string]string
	// firstMessagesFull caches the longer first-message copy (≈800 chars)
	// Nexus uses for title generation. Keyed + GC'd like firstMessages.
	firstMessagesFull map[string]string
	// turnCounts caches parsed block counts per session when the underlying
	// JSONL file has not changed. Refresh runs frequently; re-parsing every
	// session file on every tick is wasteful on large histories.
	turnCounts map[string]turnCountCacheEntry
	// firstScanDone closes after the first completed Refresh. The initial
	// scan of a large session home takes tens of seconds, and the daemon
	// boots it in the BACKGROUND so the local API and the Nexus control WS
	// come up within ~a second of process start (shrinking the visible
	// "daemon offline" window across restarts). Read paths that need a
	// complete index (FindSession) gate on this instead of racing the scan.
	firstScanOnce sync.Once
	firstScanDone chan struct{}
}

// Status is a read-only snapshot of the indexer's health. It is exposed
// through /api/status so stale in-memory catalogs are visible without
// attaching a debugger to the daemon process.
type Status struct {
	LastScan     time.Time `json:"last_scan,omitempty"`
	LastError    string    `json:"last_error,omitempty"`
	ProjectCount int       `json:"project_count"`
	SessionCount int       `json:"session_count"`
}

func New(cfg Config) *Index {
	return &Index{
		cfg:               cfg,
		sessions:          map[string]SessionRef{},
		changes:           make(chan struct{}, 1),
		firstMessages:     map[string]string{},
		firstMessagesFull: map[string]string{},
		turnCounts:        map[string]turnCountCacheEntry{},
		firstScanDone:     make(chan struct{}),
	}
}

// Start refreshes once immediately, then periodically until ctx is cancelled.
func (i *Index) Start(ctx context.Context) {
	_ = i.Refresh()

	watcher, err := fsnotify.NewWatcher()
	if err != nil {
		log.Printf("pockly-daemon index: fsnotify unavailable, fallback to polling only: %v", err)
		i.runPollingOnly(ctx)
		return
	}
	defer watcher.Close()

	if err := i.addWatchRoots(watcher); err != nil {
		log.Printf("pockly-daemon index: add watch roots: %v", err)
	}

	refreshCh := make(chan struct{}, 1)
	requestRefresh := func() {
		select {
		case refreshCh <- struct{}{}:
		default:
		}
	}

	var ticker *time.Ticker
	if i.cfg.RefreshInterval > 0 {
		ticker = time.NewTicker(i.cfg.RefreshInterval)
		defer ticker.Stop()
	}

	var debounce *time.Timer
	var debounceC <-chan time.Time

	for {
		select {
		case <-ctx.Done():
			if debounce != nil {
				debounce.Stop()
			}
			return

		case <-refreshCh:
			if debounce == nil {
				debounce = time.NewTimer(150 * time.Millisecond)
				debounceC = debounce.C
			} else {
				if !debounce.Stop() {
					select {
					case <-debounce.C:
					default:
					}
				}
				debounce.Reset(150 * time.Millisecond)
			}

		case <-debounceC:
			_ = i.Refresh()
			if err := i.addWatchRoots(watcher); err != nil {
				log.Printf("pockly-daemon index: refresh watch roots: %v", err)
			}
			debounceC = nil

		case event, ok := <-watcher.Events:
			if !ok {
				log.Printf("pockly-daemon index: fsnotify events channel closed, falling back to polling")
				i.runPollingOnly(ctx)
				return
			}
			if event.Op&(fsnotify.Create|fsnotify.Write|fsnotify.Remove|fsnotify.Rename) == 0 {
				continue
			}
			if event.Op&fsnotify.Create != 0 {
				if info, err := os.Stat(event.Name); err == nil && info.IsDir() {
					_ = i.addWatchDirRecursive(watcher, event.Name)
				}
			}
			if shouldRefreshForPath(event.Name) {
				requestRefresh()
			}

		case err, ok := <-watcher.Errors:
			if !ok {
				log.Printf("pockly-daemon index: fsnotify errors channel closed, falling back to polling")
				i.runPollingOnly(ctx)
				return
			}
			log.Printf("pockly-daemon index watcher error: %v", err)

		case <-tickerC(ticker):
			_ = i.Refresh()
			if err := i.addWatchRoots(watcher); err != nil {
				log.Printf("pockly-daemon index: periodic watch root refresh: %v", err)
			}
		}
	}
}

// Refresh rebuilds the in-memory snapshot from disk.
func (i *Index) Refresh() error {
	i.refreshMu.Lock()
	defer i.refreshMu.Unlock()
	return i.refreshLocked()
}

// waitFirstScan blocks until the initial background scan has completed, with
// a generous ceiling so a pathologically slow disk degrades to the old
// race-the-scan behavior instead of deadlocking callers.
func (i *Index) waitFirstScan() {
	select {
	case <-i.firstScanDone:
	case <-time.After(2 * time.Minute):
	}
}

// RefreshIfStale rebuilds the snapshot only when the last successful scan is
// older than maxAge. It still refreshes immediately if the previous scan failed.
func (i *Index) RefreshIfStale(maxAge time.Duration) error {
	i.refreshMu.Lock()
	defer i.refreshMu.Unlock()

	if maxAge > 0 {
		i.mu.RLock()
		fresh := i.lastErr == nil && !i.lastScan.IsZero() && time.Since(i.lastScan) < maxAge
		i.mu.RUnlock()
		if fresh {
			return nil
		}
	}
	return i.refreshLocked()
}

func (i *Index) refreshLocked() error {
	projects, sessions, err := buildSnapshot(i.cfg)
	if err == nil {
		i.populateFirstMessages(projects, sessions)
	}
	snapshot := snapshotSignature(projects)

	i.mu.Lock()
	changed := false
	if err == nil {
		i.projects = projects
		i.sessions = sessions
		i.lastScan = time.Now()
		changed = i.snapshot != snapshot
		i.snapshot = snapshot
	}
	i.lastErr = err
	i.mu.Unlock()
	// Any completed scan — even a failed one — unblocks the first-scan gate:
	// waiters must not hang on a permanently broken home dir.
	i.firstScanOnce.Do(func() { close(i.firstScanDone) })
	if changed {
		i.notifyChanged()
	}
	return err
}

// populateFirstMessages walks the freshly-built snapshot and fills in
// each session's FirstMessage field. Hits go through a cache because
// once a session has a first user message that message is immutable —
// the FIRST one — so re-parsing on every catalog tick is wasted work.
// IMPORTANT: only non-empty extractions get cached. An empty result
// might mean "no user message yet" (session is mid-write) — those need
// to be re-checked on subsequent refreshes so a newly-arrived first
// message is indexed instead of staying frozen as "".
// Cache entries for sessions that vanished from the snapshot are
// dropped so memory doesn't grow unbounded across the daemon's lifetime.
func (i *Index) populateFirstMessages(projects []agent.Project, sessions map[string]SessionRef) {
	i.mu.Lock()
	defer i.mu.Unlock()
	live := make(map[string]struct{}, len(sessions))
	for sid, ref := range sessions {
		live[sid] = struct{}{}
		count := i.countSessionBlocksCached(sid, ref)
		cached := i.firstMessages[sid]
		cachedFull := i.firstMessagesFull[sid]
		if cached == "" {
			raw := extractRawFirstMessage(ref)
			cached = cleanFirstMessageText(raw)
			cachedFull = firstMessageForTitle(raw)
			if cached != "" {
				i.firstMessages[sid] = cached
				i.firstMessagesFull[sid] = cachedFull
			}
		}
		for pi := range projects {
			for si := range projects[pi].Sessions {
				if projects[pi].Sessions[si].SessionID == sid {
					projects[pi].Sessions[si].TurnCount = count
					if cached != "" {
						projects[pi].Sessions[si].FirstMessage = cached
						projects[pi].Sessions[si].FirstMessageForTitle = cachedFull
					}
				}
			}
		}
	}
	for sid := range i.firstMessages {
		if _, ok := live[sid]; !ok {
			delete(i.firstMessages, sid)
			delete(i.firstMessagesFull, sid)
			delete(i.turnCounts, sid)
		}
	}
}

type turnCountCacheEntry struct {
	path    string
	agent   string
	modTime time.Time
	size    int64
	count   int
}

func (i *Index) countSessionBlocksCached(sessionID string, ref SessionRef) int {
	info, err := os.Stat(ref.Path)
	if err != nil {
		delete(i.turnCounts, sessionID)
		return 0
	}
	if cached, ok := i.turnCounts[sessionID]; ok &&
		cached.path == ref.Path &&
		cached.agent == ref.Agent &&
		cached.size == info.Size() &&
		cached.modTime.Equal(info.ModTime()) {
		return cached.count
	}
	count := countSessionBlocks(ref)
	i.turnCounts[sessionID] = turnCountCacheEntry{
		path:    ref.Path,
		agent:   ref.Agent,
		modTime: info.ModTime(),
		size:    info.Size(),
		count:   count,
	}
	return count
}

func countSessionBlocks(ref SessionRef) int {
	blocks, err := extractBlocks(ref)
	if err != nil {
		return 0
	}
	return len(blocks.Blocks)
}

// extractRawFirstMessage runs the per-agent first-user-message extractor.
// Both agents read the first human message straight off the local jsonl,
// independent of Nexus turn lazy-loading. Returns "" when none is found
// (empty session, parse failure, unsupported agent).
func extractRawFirstMessage(ref SessionRef) string {
	switch ref.Agent {
	case agentClaude:
		return claude.ExtractFirstUserMessage(ref.Path)
	case agentCodex:
		return codex.ExtractFirstUserMessage(ref.Path)
	default:
		return ""
	}
}

func extractBlocks(ref SessionRef) (agent.SessionBlocks, error) {
	switch ref.Agent {
	case agentClaude:
		return claude.ExtractBlocks(ref.Path)
	case agentCodex:
		return codex.ExtractBlocks(ref.Path)
	default:
		return agent.SessionBlocks{}, nil
	}
}

// cleanFirstMessageText strips the auto-injected wrappers (system-reminder,
// command-*, Codex boilerplate) and collapses whitespace, mirroring the
// browser-side deriveSessionTitle. Caps at 140 chars for the sidebar
// snippet; the browser re-truncates to its own limit if needed.
func cleanFirstMessageText(text string) string {
	return cleanFirstMessageTextCapped(text, 140)
}

// firstMessageForTitle cleans like cleanFirstMessageText but keeps a longer
// prefix (≈800 chars) — Nexus summarizes this into a session title and
// wants more context than the 140-char sidebar snippet.
func firstMessageForTitle(text string) string {
	return cleanFirstMessageTextCapped(text, 800)
}

func cleanFirstMessageTextCapped(text string, maxChars int) string {
	if text == "" {
		return ""
	}
	cleaned := text
	for _, re := range firstMessageStripPatterns {
		cleaned = re.ReplaceAllString(cleaned, "")
	}
	cleaned = strings.Join(strings.Fields(cleaned), " ")
	cleaned = strings.TrimSpace(cleaned)
	if cleaned == "" {
		return ""
	}
	if len([]rune(cleaned)) <= maxChars {
		return cleaned
	}
	runes := []rune(cleaned)
	return strings.TrimSpace(string(runes[:maxChars-1])) + "…"
}

// Projects returns a stable copy of the current project snapshot.
func (i *Index) Projects() []agent.Project {
	i.mu.RLock()
	defer i.mu.RUnlock()

	out := make([]agent.Project, len(i.projects))
	for idx, p := range i.projects {
		out[idx] = agent.Project{
			Agent:    p.Agent,
			Cwd:      p.Cwd,
			Sessions: append([]agent.Session(nil), p.Sessions...),
		}
	}
	return out
}

// Status returns index health and snapshot size counters.
func (i *Index) Status() Status {
	i.mu.RLock()
	defer i.mu.RUnlock()

	status := Status{
		LastScan:     i.lastScan,
		ProjectCount: len(i.projects),
		SessionCount: len(i.sessions),
	}
	if i.lastErr != nil {
		status.LastError = i.lastErr.Error()
	}
	return status
}

// FindSession returns the indexed path for a session ID. It waits for the
// initial background scan to complete first — correctness paths (inject
// resume, session delete) must never act on the boot-time empty index.
func (i *Index) FindSession(sessionID string) (SessionRef, bool) {
	i.waitFirstScan()
	i.mu.RLock()
	defer i.mu.RUnlock()
	ref, ok := i.sessions[sessionID]
	return ref, ok
}

// Changes emits when a Refresh observes a different session snapshot.
func (i *Index) Changes() <-chan struct{} {
	return i.changes
}

func (i *Index) notifyChanged() {
	select {
	case i.changes <- struct{}{}:
	default:
	}
}

// buildSnapshot constructs the catalog snapshot uploaded to Nexus.
//
// The catalog snapshot contains session metadata and title/snippet fields used
// by Nexus and the web sidebar. Full turn content is synced by the per-session
// history path.
func buildSnapshot(cfg Config) ([]agent.Project, map[string]SessionRef, error) {
	var projects []agent.Project
	sessions := map[string]SessionRef{}

	if cfg.ClaudeHome != "" {
		claudeProjects, err := claude.ListProjects(cfg.ClaudeHome)
		if err != nil {
			return nil, nil, err
		}
		for _, p := range claudeProjects {
			project := agent.Project{
				Agent:    agentClaude,
				Cwd:      p.Cwd,
				Sessions: make([]agent.Session, 0, len(p.Sessions)),
			}
			for _, s := range p.Sessions {
				session := buildCatalogSession(s.ID, s.Path, "")
				session.Snippet = catalogSessionTitle(agentClaude, p.Cwd, s.ID, session.Timestamp)
				project.Sessions = append(project.Sessions, session)
				sessions[s.ID] = SessionRef{
					Agent: agentClaude,
					Cwd:   p.Cwd,
					Path:  s.Path,
				}
			}
			sortSessions(project.Sessions)
			if len(project.Sessions) > 0 {
				projects = append(projects, project)
			}
		}
	}

	if cfg.CodexHome != "" {
		codexProjects, err := codex.ListProjects(cfg.CodexHome)
		if err != nil {
			return nil, nil, err
		}
		for _, p := range codexProjects {
			project := agent.Project{
				Agent:    agentCodex,
				Cwd:      p.Cwd,
				Sessions: make([]agent.Session, 0, len(p.Sessions)),
			}
			for _, s := range p.Sessions {
				session := buildCatalogSession(s.SessionID, s.Path, "")
				// Codex names rollout files with a dashed wall-clock stamp
				// ("...T17-06-32") that is not RFC3339-parseable; the web would
				// render it raw. Prefer the file mtime (like Claude), falling
				// back to a normalized form of the filename stamp, so the catalog
				// always carries a parseable timestamp.
				session.Timestamp = firstNonEmpty(session.Timestamp, normalizeCodexTimestamp(s.Timestamp))
				session.Snippet = catalogSessionTitle(agentCodex, p.Cwd, s.SessionID, session.Timestamp)
				project.Sessions = append(project.Sessions, session)
				sessions[s.SessionID] = SessionRef{
					Agent: agentCodex,
					Cwd:   p.Cwd,
					Path:  s.Path,
				}
			}
			sortSessions(project.Sessions)
			if len(project.Sessions) > 0 {
				projects = append(projects, project)
			}
		}
	}

	sort.Slice(projects, func(i, j int) bool {
		if projects[i].Cwd == projects[j].Cwd {
			return projects[i].Agent < projects[j].Agent
		}
		return projects[i].Cwd < projects[j].Cwd
	})
	return projects, sessions, nil
}

func snapshotSignature(projects []agent.Project) string {
	var b strings.Builder
	for _, project := range projects {
		b.WriteString(project.Agent)
		b.WriteByte('\x00')
		b.WriteString(project.Cwd)
		b.WriteByte('\x00')
		for _, session := range project.Sessions {
			b.WriteString(session.SessionID)
			b.WriteByte('\x00')
			b.WriteString(session.Timestamp)
			b.WriteByte('\x00')
		}
	}
	return b.String()
}

func buildCatalogSession(sessionID, path, snippet string) agent.Session {
	session := agent.Session{
		SessionID: sessionID,
		Snippet:   snippet,
	}
	if info, err := os.Stat(path); err == nil {
		session.Timestamp = info.ModTime().UTC().Format(time.RFC3339Nano)
	}
	return session
}

// normalizeCodexTimestamp converts Codex's dashed filename stamp
// ("2026-06-05T17-06-32") into an RFC3339 timestamp. The stamp is local
// wall-clock time, so it is parsed in the local zone. Values that are already
// parseable (or in an unknown shape) are returned unchanged.
func normalizeCodexTimestamp(ts string) string {
	if ts == "" {
		return ""
	}
	if t, err := time.ParseInLocation("2006-01-02T15-04-05", ts, time.Local); err == nil {
		return t.UTC().Format(time.RFC3339)
	}
	return ts
}

func catalogSessionTitle(agentName, cwd, sessionID, timestamp string) string {
	project := filepath.Base(strings.TrimRight(cwd, string(os.PathSeparator)))
	if project == "." || project == string(os.PathSeparator) || project == "" {
		project = "Session"
	}
	agentLabel := "Claude Code"
	if agentName == agentCodex {
		agentLabel = "Codex"
	}
	parts := []string{project, agentLabel}
	if formatted := formatCatalogTimestamp(timestamp); formatted != "" {
		parts = append(parts, formatted)
	}
	if shortID := shortSessionID(sessionID); shortID != "" {
		parts = append(parts, shortID)
	}
	return strings.Join(parts, " · ")
}

func formatCatalogTimestamp(timestamp string) string {
	if timestamp == "" {
		return ""
	}
	if parsed, err := time.Parse(time.RFC3339, timestamp); err == nil {
		return parsed.Local().Format("2006-01-02 15:04")
	}
	normalized := strings.Replace(timestamp, "T", " ", 1)
	if len(normalized) >= len("2006-01-02 15:04") {
		normalized = normalized[:len("2006-01-02 15:04")]
		if len(normalized) == len("2006-01-02 15:04") {
			timePart := strings.ReplaceAll(normalized[len("2006-01-02 "):], "-", ":")
			return normalized[:len("2006-01-02 ")] + timePart
		}
	}
	return normalized
}

func shortSessionID(sessionID string) string {
	if len(sessionID) <= 8 {
		return sessionID
	}
	return sessionID[:8]
}

func buildSessionSummary(sessionID string, blocks []agent.Block) agent.Session {
	summary := agent.Session{SessionID: sessionID}
	for _, b := range blocks {
		if b.Timestamp != "" {
			summary.Timestamp = b.Timestamp
		}
		if summary.Snippet == "" && b.Kind == agent.BlockUserMessage {
			summary.Snippet = truncateSingleLine(b.Text, 140)
		}
	}
	if summary.Snippet == "" {
		summary.Snippet = "(empty session)"
	}
	return summary
}

func truncateSingleLine(s string, max int) string {
	s = strings.TrimSpace(strings.ReplaceAll(s, "\n", " "))
	s = strings.Join(strings.Fields(s), " ")
	if len(s) <= max {
		return s
	}
	return strings.TrimSpace(s[:max-1]) + "…"
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func sortSessions(sessions []agent.Session) {
	sort.Slice(sessions, func(i, j int) bool {
		if sessions[i].Timestamp == sessions[j].Timestamp {
			return sessions[i].SessionID > sessions[j].SessionID
		}
		return sessions[i].Timestamp > sessions[j].Timestamp
	})
}

func (i *Index) runPollingOnly(ctx context.Context) {
	if i.cfg.RefreshInterval <= 0 {
		<-ctx.Done()
		return
	}
	ticker := time.NewTicker(i.cfg.RefreshInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_ = i.Refresh()
		}
	}
}

func (i *Index) addWatchRoots(w *fsnotify.Watcher) error {
	for _, root := range i.watchRoots() {
		if root == "" {
			continue
		}
		if err := i.addWatchDirRecursive(w, root); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

func (i *Index) watchRoots() []string {
	roots := make([]string, 0, 3)
	if i.cfg.ClaudeHome != "" {
		roots = append(roots, i.cfg.ClaudeHome)
	}
	if i.cfg.CodexHome != "" {
		roots = append(roots,
			filepath.Join(i.cfg.CodexHome, "sessions"),
			filepath.Join(i.cfg.CodexHome, "archived_sessions"),
		)
	}
	return roots
}

func (i *Index) addWatchDirRecursive(w *fsnotify.Watcher, root string) error {
	info, err := os.Stat(root)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return nil
	}
	return filepath.WalkDir(root, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if !d.IsDir() {
			return nil
		}
		if addErr := w.Add(path); addErr != nil {
			// Duplicates or transient races should not break the indexer.
			if strings.Contains(addErr.Error(), "already exists") {
				return nil
			}
			return addErr
		}
		return nil
	})
}

func shouldRefreshForPath(path string) bool {
	base := filepath.Base(path)
	if strings.HasSuffix(base, ".jsonl") {
		return true
	}
	return filepath.Ext(base) == ""
}

func tickerC(t *time.Ticker) <-chan time.Time {
	if t == nil {
		return nil
	}
	return t.C
}
