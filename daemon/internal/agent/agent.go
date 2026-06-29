// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

// Package agent defines daemon-internal types shared across all coding-agent
// integrations (claude-code, codex, future hermes / opencode / openclaw).
//
// Subpackages under internal/agent/<name>/ produce these types from each
// agent's session storage. Nexus forwards them to the web app unchanged
// — they are the daemon ↔ browser canonical form.
package agent

import "encoding/json"

// BlockKind discriminates block payloads when serialized over the wire.
type BlockKind string

const (
	BlockUserMessage   BlockKind = "user_message"
	BlockAssistantText BlockKind = "assistant_text"
	BlockToolCall      BlockKind = "tool_call"
	BlockToolResult    BlockKind = "tool_result"
	BlockThinking      BlockKind = "thinking"
	BlockAttachment    BlockKind = "attachment"
	BlockMeta          BlockKind = "meta"
	// BlockImage carries a base64 or URL image part embedded in a user
	// or assistant message. Distinct kind so the web renderer can mount
	// an <img> tag without sniffing payload fields.
	BlockImage BlockKind = "image"
)

// Block is the canonical renderer-friendly turn unit.
//
// Fields are kind-specific and use omitempty so each JSON object only
// carries fields relevant to its Kind.
type Block struct {
	Kind      BlockKind `json:"kind"`
	Timestamp string    `json:"timestamp,omitempty"`
	UUID      string    `json:"uuid,omitempty"`

	// Text — populated for user_message, assistant_text, thinking, attachment.
	Text string `json:"text,omitempty"`

	// AttachmentType — populated for attachment.
	AttachmentType string `json:"attachment_type,omitempty"`

	// MetaType — populated for meta record passthrough blocks.
	MetaType string `json:"meta_type,omitempty"`

	// Tool call fields — populated for tool_call.
	Tool      string          `json:"tool,omitempty"`
	ID        string          `json:"id,omitempty"`
	Input     json.RawMessage `json:"input,omitempty"`
	Result    string          `json:"result,omitempty"`
	IsError   bool            `json:"is_error,omitempty"`
	HasResult bool            `json:"has_result,omitempty"`

	// Subagent threading — set on blocks extracted from a sidechain
	// conversation that was spawned by a Task tool call. The web renderer
	// uses ParentToolUseID to nest these blocks under the spawning
	// tool_call card so the user can collapse / expand the subagent's
	// internal steps. IsSidechain is the raw flag from the JSONL.
	ParentToolUseID string `json:"parent_tool_use_id,omitempty"`
	IsSidechain     bool   `json:"is_sidechain,omitempty"`

	// Token usage — attached to the last block extracted from an
	// assistant message envelope. Lets the web compute a rolling
	// "context window used" indicator without re-decoding the JSONL.
	// All four fields are independent omitempty so a partial usage
	// record still serializes cleanly.
	InputTokens         int `json:"input_tokens,omitempty"`
	OutputTokens        int `json:"output_tokens,omitempty"`
	CacheCreationTokens int `json:"cache_creation_input_tokens,omitempty"`
	CacheReadTokens     int `json:"cache_read_input_tokens,omitempty"`

	// Image fields — populated on BlockImage. ImageMediaType is the
	// Claude-reported MIME type (e.g. "image/png"). ImageData is raw
	// base64 (web wraps it into a data URL on render); ImageURL is the
	// fallback for source.type=="url" emissions.
	ImageMediaType string `json:"image_media_type,omitempty"`
	ImageData      string `json:"image_data,omitempty"`
	ImageURL       string `json:"image_url,omitempty"`

	// Edit-diff fields — populated on a BlockToolResult for an
	// Edit/Write/MultiEdit tool. EditFilePath is the changed file. EditPatch
	// is Claude's own computed unified diff (the jsonl `structuredPatch`
	// hunks: [{oldStart,oldLines,newStart,newLines,lines:["+…","-…"," …"]}]),
	// passed through verbatim so the web can show which files changed without
	// re-diffing. EditUserModified is true when the user hand-edited the file
	// between Claude's read and write. EditPatch is omitted when it exceeds the
	// size cap (maxEditPatchBytes) — EditFilePath stays so the web can fall
	// back to the tool call's old/new strings.
	EditFilePath     string          `json:"edit_file_path,omitempty"`
	EditPatch        json.RawMessage `json:"edit_patch,omitempty"`
	EditUserModified bool            `json:"edit_user_modified,omitempty"`
}

// SessionBlocks is the full extracted view of one session.
type SessionBlocks struct {
	SessionID string  `json:"session_id"`
	Cwd       string  `json:"cwd,omitempty"`
	Agent     string  `json:"agent"`
	Blocks    []Block `json:"blocks"`
}

// Project groups sessions by their working directory across one agent.
//
// Used in the daemon's local HTTP API to render the list view.
type Project struct {
	Agent    string    `json:"agent"`
	Cwd      string    `json:"cwd"`
	Sessions []Session `json:"sessions"`
}

// Session is the listing-shape entry for the project list view.
type Session struct {
	SessionID string `json:"session_id"`
	// Title is the agent-provided display title when the agent keeps one
	// separately from the first user message (for example Codex thread_name).
	Title string `json:"title,omitempty"`
	// Timestamp is best-effort: claude jsonl filenames are pure UUIDs,
	// but the indexer upgrades it to the latest seen block timestamp.
	Timestamp string `json:"timestamp,omitempty"`
	// TurnCount is the number of renderer blocks currently present in the
	// local session file. Catalog sync uses this as metadata only; turn
	// payloads stay on disk until a window sync uploads them.
	TurnCount int `json:"turn_count,omitempty"`
	// Snippet is a short preview string for the list view, usually the
	// first user message in the session.
	Snippet string `json:"snippet,omitempty"`
	// FirstMessage is the plaintext of the first user message in the
	// session (whitespace-collapsed, command/system-reminder tags
	// stripped, truncated). Populated by the indexer for catalog use.
	// Sent in catalog sync so Nexus can build useful session labels.
	FirstMessage string `json:"first_message,omitempty"`
	// FirstMessageForTitle is a longer (≈800 char) cleaned copy of the
	// first user message. Same stripping as FirstMessage but a higher cap;
	// Nexus summarizes it into a session title. Stays on the daemon
	// except as a plaintext catalog-sync field.
	FirstMessageForTitle string `json:"first_message_for_title,omitempty"`
}
