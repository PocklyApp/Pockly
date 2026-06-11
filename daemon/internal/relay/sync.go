// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package relay

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"path/filepath"
	"sort"
	"strings"

	"github.com/PocklyApp/Pockly/daemon/internal/agent"
	"github.com/PocklyApp/Pockly/daemon/internal/agent/claude"
	"github.com/PocklyApp/Pockly/daemon/internal/agent/codex"
	"github.com/PocklyApp/Pockly/daemon/internal/index"
	"github.com/PocklyApp/Pockly/daemon/internal/pair"
	"github.com/PocklyApp/Pockly/daemon/internal/runner"
	"github.com/PocklyApp/Pockly/daemon/internal/version"
)

// catalogSyncMaxBytes bounds the full-catalog sync POST body. Nexus may sit
// behind nginx, whose default client_max_body_size is 1 MiB; a daemon that has
// accumulated thousands of sessions can otherwise blow past that and leave the
// web catalog stale.
//
// We keep the JSON body comfortably under 1 MiB. Sessions are emitted
// most-recent-first, so when the budget is hit the OLDEST sessions are
// the ones dropped from this snapshot. A capped catalog is not an
// authoritative deletion list, so callers must not set FullReconcile when
// CatalogComplete is false.
const catalogSyncMaxBytes = 900_000

// catalogSyncBaseOverheadBytes is a conservative estimate of the JSON
// envelope around the sessions/snippets arrays (Hello block, field
// names, brackets, full_reconcile flag). Kept generous so the running
// total never undershoots the real marshaled size.
const catalogSyncBaseOverheadBytes = 1024

// approxJSONLen returns the marshaled byte length of v, or 0 if it can't
// be marshaled. Used to budget the catalog sync body incrementally
// without re-marshaling the whole request each iteration.
func approxJSONLen(v any) int {
	b, err := json.Marshal(v)
	if err != nil {
		return 0
	}
	// +1 for the comma/array separator this element contributes.
	return len(b) + 1
}

func BuildSyncRequest(idx *index.Index, daemonDeviceID string, profile runner.Profile) (pair.SyncRequest, error) {
	return BuildCatalogSyncRequest(idx, daemonDeviceID, profile)
}

// BuildCatalogSyncSessions returns the complete, globally-recency-sorted
// session metadata snapshot. BuildCatalogSyncRequest may byte-cap the HTTP
// payload, but daemon-side lazy backfill still needs the full local list so a
// Nexus sync hint for an older opened session can be honored.
func BuildCatalogSyncSessions(idx *index.Index, profile runner.Profile) []pair.SyncSession {
	projects := idx.Projects()
	// Flatten (project, session) across all supported agent projects.
	// idx.Projects() orders projects by cwd and sessions within a project by
	// recency, but NOT globally by recency — so to keep the most recent
	// sessions when we hit the byte budget below we must sort the flattened
	// list ourselves.
	type catalogEntry struct {
		agentName string
		cwd       string
		session   agent.Session
	}
	entries := make([]catalogEntry, 0, len(projects))
	for _, project := range projects {
		if !isSupportedSyncAgent(project.Agent) {
			continue
		}
		for _, session := range project.Sessions {
			entries = append(entries, catalogEntry{agentName: project.Agent, cwd: project.Cwd, session: session})
		}
	}
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].session.Timestamp == entries[j].session.Timestamp {
			return entries[i].session.SessionID > entries[j].session.SessionID
		}
		return entries[i].session.Timestamp > entries[j].session.Timestamp
	})

	sessions := make([]pair.SyncSession, 0, len(entries))
	for _, entry := range entries {
		session := entry.session
		title := firstNonEmpty(session.FirstMessageForTitle, session.FirstMessage, session.Snippet)
		snippet := firstNonEmpty(session.FirstMessage, session.Snippet, title)
		sessions = append(sessions, pair.SyncSession{
			SessionID:         session.SessionID,
			Agent:             entry.agentName,
			RunnerAlias:       profile.AliasFor(entry.agentName),
			Cwd:               safeCwdLabel(entry.cwd),
			Title:             title,
			Snippet:           snippet,
			FirstMessage:      session.FirstMessageForTitle,
			LastSeq:           0,
			LastTimestamp:     session.Timestamp,
			ChannelLastSeenAt: session.Timestamp,
			SyncState:         "catalog_only",
			TurnCount:         session.TurnCount,
		})
	}
	return sessions
}

func BuildCatalogSyncRequest(idx *index.Index, daemonDeviceID string, profile runner.Profile) (pair.SyncRequest, error) {
	req := pair.SyncRequest{
		Hello: pair.HelloMessage{
			DeviceID: daemonDeviceID,
			Version:  version.String(),
		},
		CatalogComplete: true,
	}

	// Emit most-recent-first, accumulating an estimate of the marshaled
	// body size. Stop before crossing catalogSyncMaxBytes so the POST stays
	// under nginx's body limit. Sessions past the cap are the oldest, so
	// dropping them costs the least.
	sessions := BuildCatalogSyncSessions(idx, profile)
	approxBytes := catalogSyncBaseOverheadBytes
	totalEligible := len(sessions)
	emitted := 0
	for _, ss := range sessions {
		// Always emit at least one session so a single oversized entry can't
		// produce an empty catalog (it would still 413, but Nexus would at
		// least see one session rather than reconcile to zero).
		unitBytes := approxJSONLen(ss)
		if emitted > 0 && approxBytes+unitBytes > catalogSyncMaxBytes {
			req.CatalogComplete = false
			break
		}
		approxBytes += unitBytes
		req.Sessions = append(req.Sessions, ss)
		emitted++
	}

	if emitted < totalEligible {
		// No silent truncation: surface that the catalog was capped so the
		// dropped-oldest behavior is visible in logs (and so a future
		// delta-sync / Nexus GC effort has a breadcrumb).
		log.Printf("Nexus sync: catalog capped to %d of %d sessions (~%d bytes) to stay under Nexus body limit; oldest %d dropped from this snapshot",
			emitted, totalEligible, approxBytes, totalEligible-emitted)
	}

	return req, nil
}

type SyncProgress struct {
	Stage     string
	Processed int
	Total     int
	Message   string
	MinSeq    int
	MaxSeq    int
	HasOlder  bool
	TurnCount int
}

type SessionWindow struct {
	Limit     int
	BeforeSeq int
}

func BuildSingleSessionSyncRequest(idx *index.Index, daemonDeviceID, sessionID string, profile runner.Profile, progress func(SyncProgress)) (pair.SyncRequest, error) {
	return BuildSingleSessionSyncRequestContext(context.Background(), idx, daemonDeviceID, sessionID, profile, progress)
}

func BuildSingleSessionSyncRequestContext(ctx context.Context, idx *index.Index, daemonDeviceID, sessionID string, profile runner.Profile, progress func(SyncProgress)) (pair.SyncRequest, error) {
	return BuildSingleSessionWindowSyncRequestContext(ctx, idx, daemonDeviceID, sessionID, profile, SessionWindow{}, progress)
}

func BuildSingleSessionWindowSyncRequestContext(ctx context.Context, idx *index.Index, daemonDeviceID, sessionID string, profile runner.Profile, window SessionWindow, progress func(SyncProgress)) (pair.SyncRequest, error) {
	req := pair.SyncRequest{
		Hello: pair.HelloMessage{
			DeviceID: daemonDeviceID,
			Version:  version.String(),
		},
	}
	if progress != nil {
		progress(SyncProgress{Stage: "locating", Message: "Locating session"})
	}
	ref, ok := idx.FindSession(sessionID)
	if !ok {
		return req, fmt.Errorf("session_not_found")
	}
	if !isSupportedSyncAgent(ref.Agent) {
		return req, fmt.Errorf("agent_not_supported")
	}
	if progress != nil {
		progress(SyncProgress{Stage: "extracting", Message: "Extracting history"})
	}
	data, err := extractSessionBlocks(ref)
	if err != nil {
		return req, fmt.Errorf("extract_failed: %w", err)
	}
	totalCount := len(data.Blocks)
	windowed, minSeq, maxSeq, hasOlder := selectBlockWindow(data.Blocks, window)
	total := len(windowed)
	for idx, block := range windowed {
		if err := ctx.Err(); err != nil {
			return req, err
		}
		if progress != nil {
			progress(SyncProgress{Stage: "extracting", Processed: idx + 1, Total: total, Message: "Extracting history", MinSeq: minSeq, MaxSeq: maxSeq, HasOlder: hasOlder, TurnCount: totalCount})
		}
		payload, err := payloadForBlock(block)
		if err != nil {
			return req, fmt.Errorf("extract_failed: %w", err)
		}
		seq := minSeq + idx
		req.Turns = append(req.Turns, pair.SyncTurn{
			SessionID: sessionID,
			Seq:       seq,
			Agent:     ref.Agent,
			Kind:      string(block.Kind),
			Timestamp: block.Timestamp,
			Payload:   payload,
		})
	}
	syncState := "fully_synced"
	if hasOlder || minSeq > 1 {
		syncState = "partial"
	}
	title := firstNonEmpty(firstUserMessageTitle(data.Blocks), safeSessionTitle(ref.Agent, firstNonEmpty(data.Cwd, ref.Cwd), sessionID))
	req.Sessions = append(req.Sessions, pair.SyncSession{
		SessionID:         sessionID,
		Agent:             ref.Agent,
		RunnerAlias:       profile.AliasFor(ref.Agent),
		Cwd:               safeCwdLabel(firstNonEmpty(data.Cwd, ref.Cwd)),
		Title:             title,
		Snippet:           title,
		LastSeq:           totalCount,
		LastTimestamp:     lastBlockTimestamp(data.Blocks, ""),
		ChannelLastSeenAt: lastBlockTimestamp(data.Blocks, ""),
		SyncState:         syncState,
		TurnCount:         totalCount,
		MinSeq:            minSeq,
		MaxSeq:            maxSeq,
		HasOlder:          hasOlder,
	})
	return req, nil
}

// isSupportedSyncAgent gates agent families that can be exposed beyond the
// daemon boundary through Nexus sync. Keep this aligned with extractSessionBlocks.
func isSupportedSyncAgent(agent string) bool {
	switch agent {
	case "claude-code", "codex":
		return true
	default:
		return false
	}
}

func selectBlockWindow(blocks []agent.Block, window SessionWindow) ([]agent.Block, int, int, bool) {
	total := len(blocks)
	if total == 0 {
		return nil, 0, 0, false
	}
	limit := window.Limit
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	endSeq := total
	if window.BeforeSeq > 0 && window.BeforeSeq-1 < endSeq {
		endSeq = window.BeforeSeq - 1
	}
	if endSeq <= 0 {
		return nil, 0, 0, false
	}
	startSeq := endSeq - limit + 1
	if startSeq < 1 {
		startSeq = 1
	}
	out := blocks[startSeq-1 : endSeq]
	return out, startSeq, endSeq, startSeq > 1
}

func extractSessionBlocks(ref index.SessionRef) (agent.SessionBlocks, error) {
	switch ref.Agent {
	case "claude-code":
		return claude.ExtractBlocks(ref.Path)
	case "codex":
		return codex.ExtractBlocks(ref.Path)
	default:
		return agent.SessionBlocks{}, fmt.Errorf("unknown agent %q", ref.Agent)
	}
}

func safeCwdLabel(cwd string) string {
	base := filepath.Base(cwd)
	if base == "." || base == "/" || base == "" {
		return "Session"
	}
	return base
}

func safeSessionTitle(agentName, cwd, sessionID string) string {
	project := safeCwdLabel(cwd)
	agentLabel := "Claude Code"
	if agentName == "codex" {
		agentLabel = "Codex"
	}
	shortID := sessionID
	if len(shortID) > 8 {
		shortID = shortID[:8]
	}
	return fmt.Sprintf("%s · %s · %s", project, agentLabel, shortID)
}

func firstUserMessageTitle(blocks []agent.Block) string {
	for _, block := range blocks {
		if block.Kind == agent.BlockUserMessage {
			if text := strings.TrimSpace(block.Text); text != "" {
				return text
			}
		}
	}
	return ""
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func lastBlockTimestamp(blocks []agent.Block, fallback string) string {
	for i := len(blocks) - 1; i >= 0; i-- {
		if blocks[i].Timestamp != "" {
			return blocks[i].Timestamp
		}
	}
	return fallback
}

// payloadForBlock is the wire-shape projection of agent.Block. Any new
// field added to agent.Block must also be threaded here — otherwise the
// struct's omitempty will swallow the field on serialization and it'll
// never reach Nexus or the browser. Add a field below AND wire it
// into the json.Marshal call.
func payloadForBlock(block agent.Block) (json.RawMessage, error) {
	type payload struct {
		UUID           string          `json:"uuid,omitempty"`
		Text           string          `json:"text,omitempty"`
		AttachmentType string          `json:"attachment_type,omitempty"`
		MetaType       string          `json:"meta_type,omitempty"`
		Tool           string          `json:"tool,omitempty"`
		ID             string          `json:"id,omitempty"`
		Input          json.RawMessage `json:"input,omitempty"`
		Result         string          `json:"result,omitempty"`
		IsError        bool            `json:"is_error,omitempty"`
		HasResult      bool            `json:"has_result,omitempty"`

		// Subagent threading + usage + image (added with the rich-renderer
		// pass). Optional on the web side, so omitempty here is safe.
		ParentToolUseID     string `json:"parent_tool_use_id,omitempty"`
		IsSidechain         bool   `json:"is_sidechain,omitempty"`
		InputTokens         int    `json:"input_tokens,omitempty"`
		OutputTokens        int    `json:"output_tokens,omitempty"`
		CacheCreationTokens int    `json:"cache_creation_input_tokens,omitempty"`
		CacheReadTokens     int    `json:"cache_read_input_tokens,omitempty"`
		ImageMediaType      string `json:"image_media_type,omitempty"`
		ImageData           string `json:"image_data,omitempty"`
		ImageURL            string `json:"image_url,omitempty"`

		// Edit-diff projection (Claude's structuredPatch on Edit/Write results).
		EditFilePath     string          `json:"edit_file_path,omitempty"`
		EditPatch        json.RawMessage `json:"edit_patch,omitempty"`
		EditUserModified bool            `json:"edit_user_modified,omitempty"`
	}
	raw, err := json.Marshal(payload{
		UUID:                block.UUID,
		Text:                block.Text,
		AttachmentType:      block.AttachmentType,
		MetaType:            block.MetaType,
		Tool:                block.Tool,
		ID:                  block.ID,
		Input:               block.Input,
		Result:              block.Result,
		IsError:             block.IsError,
		HasResult:           block.HasResult,
		ParentToolUseID:     block.ParentToolUseID,
		IsSidechain:         block.IsSidechain,
		InputTokens:         block.InputTokens,
		OutputTokens:        block.OutputTokens,
		CacheCreationTokens: block.CacheCreationTokens,
		CacheReadTokens:     block.CacheReadTokens,
		ImageMediaType:      block.ImageMediaType,
		ImageData:           block.ImageData,
		ImageURL:            block.ImageURL,
		EditFilePath:        block.EditFilePath,
		EditPatch:           block.EditPatch,
		EditUserModified:    block.EditUserModified,
	})
	if err != nil {
		return nil, err
	}
	return json.RawMessage(raw), nil
}
