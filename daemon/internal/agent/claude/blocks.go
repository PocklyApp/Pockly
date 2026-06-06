// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

// Package claude — block extraction from session records.
//
// blocks.go turns a stream of raw Records into a flat ordered list of
// renderer-friendly agent.Blocks. Mirrors spike/blocks.py.
package claude

import (
	"encoding/json"
	"regexp"
	"strings"

	"github.com/PocklyApp/Pockly/daemon/internal/agent"
)

// ExtractBlocks reads the session at path and produces canonical blocks.
//
// Behavior matches spike/blocks.py, with a few renderer-facing additions:
//   - `user`, `assistant`, `attachment`, and selected meta records contribute.
//   - Sidechain records are dropped.
//   - tool_result content remains a first-class block in its original
//     record position so browser rendering can preserve session order.
//   - tool_result text is sanitized to strip Claude Code's
//     `<system-reminder>` injections before exposure.
//   - assistant thinking is preserved as a dedicated thinking block.
//   - top-level attachments are preserved as attachment blocks.
//
// ExtractFirstUserMessage streams the session at path and returns the
// first non-empty user text block. Bails out as soon as one is found so
// catalog indexing doesn't have to parse the full JSONL just for the
// sidebar label. Returns "" if nothing usable was found.
func ExtractFirstUserMessage(path string) string {
	for rec, err := range ParseRecords(path) {
		if err != nil {
			continue
		}
		if rec.IsSidechain || rec.Type != "user" || len(rec.Message) == 0 {
			continue
		}
		var msg messageEnvelope
		if err := json.Unmarshal(rec.Message, &msg); err != nil {
			continue
		}
		blocks := blocksForMessage(rec, msg)
		for _, b := range blocks {
			if b.Kind == agent.BlockUserMessage && b.Text != "" {
				return b.Text
			}
		}
	}
	return ""
}

// Read errors abort and return whatever was extracted so far.
func ExtractBlocks(path string) (agent.SessionBlocks, error) {
	out := agent.SessionBlocks{Agent: "claude-code"}

	// recordToToolUseID maps a non-sidechain record's UUID to the FIRST
	// tool_use id it emits. Used to resolve a sidechain record's spawning
	// Task tool_use by walking parentUuid links up the conversation tree.
	recordToToolUseID := make(map[string]string)
	recordParent := make(map[string]string)

	for rec, err := range ParseRecords(path) {
		if err != nil {
			continue // soft-fail per-line decode
		}
		if rec.SessionID != "" && out.SessionID == "" {
			out.SessionID = rec.SessionID
		}
		if rec.Cwd != "" && out.Cwd == "" {
			out.Cwd = rec.Cwd
		}
		if rec.UUID != "" {
			recordParent[rec.UUID] = rec.ParentUUID
		}

		if rec.Type == "attachment" {
			if rec.IsSidechain {
				continue // subagent chatter shouldn't drown the main feed
			}
			if block, ok := blockForAttachment(rec); ok {
				out.Blocks = append(out.Blocks, block)
			}
			continue
		}
		if isRawMetaRecord(rec.Type) {
			if rec.IsSidechain {
				continue
			}
			if block, ok := blockForMeta(rec); ok {
				out.Blocks = append(out.Blocks, block)
			}
			continue
		}

		if rec.Type != "user" && rec.Type != "assistant" {
			continue
		}
		if len(rec.Message) == 0 {
			continue
		}

		var msg messageEnvelope
		if err := json.Unmarshal(rec.Message, &msg); err != nil {
			continue
		}

		blocks := blocksForMessage(rec, msg)
		if len(blocks) == 0 {
			continue
		}

		// Capture the spawning tool_use id for any non-sidechain record so
		// later sidechain records (whose parentUuid descends from here)
		// can resolve their parent_tool_use_id. The first tool_use is good
		// enough — Task spawns are emitted one per record in practice.
		if !rec.IsSidechain && rec.UUID != "" {
			for _, b := range blocks {
				if b.Kind == agent.BlockToolCall && b.ID != "" {
					if _, ok := recordToToolUseID[rec.UUID]; !ok {
						recordToToolUseID[rec.UUID] = b.ID
					}
					break
				}
			}
		}

		// Subagent threading: tag every block from a sidechain record so
		// the web renderer can nest them under the spawning Task card.
		if rec.IsSidechain {
			parentToolUseID := resolveSidechainParent(rec.ParentUUID, recordToToolUseID, recordParent)
			for i := range blocks {
				blocks[i].IsSidechain = true
				if parentToolUseID != "" {
					blocks[i].ParentToolUseID = parentToolUseID
				}
			}
		}

		// Usage stats live on the assistant message envelope, not on any
		// individual content block. Attach to the LAST block produced from
		// this message so the renderer can surface a rolling token meter.
		if msg.Usage != nil && len(blocks) > 0 {
			last := len(blocks) - 1
			blocks[last].InputTokens = msg.Usage.InputTokens
			blocks[last].OutputTokens = msg.Usage.OutputTokens
			blocks[last].CacheCreationTokens = msg.Usage.CacheCreationInputTokens
			blocks[last].CacheReadTokens = msg.Usage.CacheReadInputTokens
		}

		out.Blocks = append(out.Blocks, blocks...)
	}

	return out, nil
}

// resolveSidechainParent walks parentUuid links upward from `start` until
// it lands on a recorded tool_use id, or runs out of ancestors. Returns
// the tool_use id of the spawning Task call, or "" when the chain is
// broken (e.g. a partial JSONL flush). Capped at 64 hops so a self-cycle
// in malformed data can't lock up the extractor.
func resolveSidechainParent(start string, toolUseByRecord, parentByRecord map[string]string) string {
	cur := start
	for i := 0; i < 64 && cur != ""; i++ {
		if id, ok := toolUseByRecord[cur]; ok {
			return id
		}
		cur = parentByRecord[cur]
	}
	return ""
}

// messageEnvelope is the shape of `record.message`.
type messageEnvelope struct {
	Role    string          `json:"role"`
	Content json.RawMessage `json:"content"`
	// Usage is present on assistant messages only and reports token
	// counts for the request that produced this message. We pass it
	// through to the renderer so it can show a context-window meter.
	Usage *usageEnvelope `json:"usage,omitempty"`
}

type usageEnvelope struct {
	InputTokens              int `json:"input_tokens"`
	OutputTokens             int `json:"output_tokens"`
	CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     int `json:"cache_read_input_tokens"`
}

// contentBlock is a single element inside message.content.
type contentBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text,omitempty"`
	Thinking  string          `json:"thinking,omitempty"`
	ID        string          `json:"id,omitempty"`
	Name      string          `json:"name,omitempty"`
	Input     json.RawMessage `json:"input,omitempty"`
	ToolUseID string          `json:"tool_use_id,omitempty"`
	Content   json.RawMessage `json:"content,omitempty"`
	IsError   bool            `json:"is_error,omitempty"`
	// Source is populated on type=="image". The Claude content schema
	// nests media type + base64 data (or external URL) under .source.
	Source *imageSource `json:"source,omitempty"`
}

type imageSource struct {
	Type      string `json:"type"`
	MediaType string `json:"media_type,omitempty"`
	Data      string `json:"data,omitempty"`
	URL       string `json:"url,omitempty"`
}

type attachmentEnvelope struct {
	Type    string          `json:"type"`
	Content json.RawMessage `json:"content,omitempty"`
}

func blocksForMessage(rec Record, msg messageEnvelope) []agent.Block {
	// Content can be a JSON string OR a JSON array of content blocks.
	if isJSONString(msg.Content) {
		var s string
		if err := json.Unmarshal(msg.Content, &s); err != nil || s == "" {
			return nil
		}
		if rec.Type == "user" {
			return []agent.Block{{
				Kind:      agent.BlockUserMessage,
				Text:      stripTerminalEscapes(s),
				Timestamp: rec.Timestamp,
				UUID:      rec.UUID,
			}}
		}
		// rare: assistant content as bare string
		return []agent.Block{{
			Kind:      agent.BlockAssistantText,
			Text:      stripTerminalEscapes(s),
			Timestamp: rec.Timestamp,
			UUID:      rec.UUID,
		}}
	}

	var parts []contentBlock
	if err := json.Unmarshal(msg.Content, &parts); err != nil {
		return nil
	}

	var out []agent.Block
	if rec.Type == "user" {
		for _, p := range parts {
			switch p.Type {
			case "text":
				if p.Text == "" {
					continue
				}
				out = append(out, agent.Block{
					Kind:      agent.BlockUserMessage,
					Text:      stripTerminalEscapes(p.Text),
					Timestamp: rec.Timestamp,
					UUID:      rec.UUID,
				})
			case "image":
				if block, ok := blockForImage(rec, p); ok {
					out = append(out, block)
				}
			case "tool_result":
				content := stripTerminalEscapes(stripSystemReminders(flattenToolResultContent(p.Content)))
				blk := agent.Block{
					Kind:      agent.BlockToolResult,
					ID:        p.ToolUseID,
					Result:    content,
					IsError:   p.IsError,
					HasResult: true,
					Timestamp: rec.Timestamp,
					UUID:      rec.UUID,
				}
				// Edit/Write/MultiEdit results carry Claude's own computed
				// diff in the record's top-level toolUseResult — surface it.
				if fp, patch, userMod, ok := editPatchFromResult(rec.ToolUseResult); ok {
					blk.EditFilePath = fp
					blk.EditPatch = patch
					blk.EditUserModified = userMod
				}
				out = append(out, blk)
			}
		}
		return out
	}

	// assistant
	for _, p := range parts {
		switch p.Type {
		case "text":
			if p.Text == "" {
				continue
			}
			// Claude occasionally splits a single logical assistant reply
			// across multiple text parts inside the same message. Merge
			// them at extraction time so block identity stays stable and
			// the reader doesn't have to glue them back together. We only
			// merge when the immediately preceding block in *this* message
			// is also assistant_text, so a tool_use between text parts
			// still produces distinct blocks.
			if len(out) > 0 && out[len(out)-1].Kind == agent.BlockAssistantText {
				out[len(out)-1].Text += "\n\n" + stripTerminalEscapes(p.Text)
				continue
			}
			out = append(out, agent.Block{
				Kind:      agent.BlockAssistantText,
				Text:      stripTerminalEscapes(p.Text),
				Timestamp: rec.Timestamp,
				UUID:      rec.UUID,
			})
		case "tool_use":
			out = append(out, agent.Block{
				Kind:      agent.BlockToolCall,
				Tool:      defaultIfEmpty(p.Name, "Unknown"),
				ID:        p.ID,
				Input:     p.Input,
				Timestamp: rec.Timestamp,
				UUID:      rec.UUID,
			})
		case "thinking":
			if p.Thinking == "" {
				continue
			}
			out = append(out, agent.Block{
				Kind:      agent.BlockThinking,
				Text:      p.Thinking,
				Timestamp: rec.Timestamp,
				UUID:      rec.UUID,
			})
		case "image":
			if block, ok := blockForImage(rec, p); ok {
				out = append(out, block)
			}
		}
	}
	return out
}

// blockForImage extracts an inline image content part. Claude's schema
// uses source.type=="base64" for inline payloads (data + media_type) and
// source.type=="url" for external refs. We pass both through and let the
// renderer pick which one to use (prefer base64 when both somehow show
// up). Returns (block, false) when nothing usable is present so the
// caller can skip silently.
func blockForImage(rec Record, p contentBlock) (agent.Block, bool) {
	if p.Source == nil {
		return agent.Block{}, false
	}
	block := agent.Block{
		Kind:      agent.BlockImage,
		Timestamp: rec.Timestamp,
		UUID:      rec.UUID,
	}
	if p.Source.MediaType != "" {
		block.ImageMediaType = p.Source.MediaType
	}
	if p.Source.Data != "" {
		block.ImageData = p.Source.Data
	}
	if p.Source.URL != "" {
		block.ImageURL = p.Source.URL
	}
	if block.ImageData == "" && block.ImageURL == "" {
		return agent.Block{}, false
	}
	return block, true
}

func defaultIfEmpty(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

func isRawMetaRecord(recordType string) bool {
	switch recordType {
	case "queue-operation", "last-prompt", "permission-mode", "file-history-snapshot", "system":
		return true
	default:
		return false
	}
}

func blockForAttachment(rec Record) (agent.Block, bool) {
	if len(rec.Attachment) == 0 {
		return agent.Block{}, false
	}
	var attachment attachmentEnvelope
	if err := json.Unmarshal(rec.Attachment, &attachment); err != nil {
		return agent.Block{}, false
	}
	text := formatAttachmentText(attachment.Type, attachment.Content, rec.Attachment)
	return agent.Block{
		Kind:           agent.BlockAttachment,
		AttachmentType: defaultIfEmpty(attachment.Type, "attachment"),
		Text:           text,
		Timestamp:      rec.Timestamp,
		UUID:           rec.UUID,
	}, true
}

func blockForMeta(rec Record) (agent.Block, bool) {
	text := formatMetaText(rec)
	return agent.Block{
		Kind:      agent.BlockMeta,
		MetaType:  rec.Type,
		Text:      text,
		Timestamp: rec.Timestamp,
		UUID:      rec.UUID,
	}, true
}

func formatAttachmentText(attachmentType string, content, raw json.RawMessage) string {
	switch {
	case isJSONString(content):
		var s string
		if err := json.Unmarshal(content, &s); err == nil {
			return s
		}
	case isJSONArray(content):
		if string(content) == "[]" {
			return ""
		}
		return prettyJSON(content)
	case len(content) > 0:
		return prettyJSON(content)
	}
	// Keep non-content attachment data visible for attachment types like
	// deferred_tools_delta where the useful payload lives in sibling fields.
	switch attachmentType {
	case "task_reminder":
		return ""
	default:
		return prettyJSON(raw)
	}
}

func formatMetaText(rec Record) string {
	switch rec.Type {
	case "queue-operation":
		return formatQueueOperation(rec.Raw)
	case "last-prompt":
		return extractStringField(rec.Raw, "lastPrompt")
	case "permission-mode":
		return extractStringField(rec.Raw, "permissionMode")
	case "file-history-snapshot":
		return extractNestedPrettyJSON(rec.Raw, "snapshot")
	case "system":
		return prettyJSON(rec.Raw)
	default:
		return prettyJSON(rec.Raw)
	}
}

func formatQueueOperation(raw json.RawMessage) string {
	var payload struct {
		Operation string `json:"operation"`
		Content   string `json:"content"`
	}
	if err := json.Unmarshal(raw, &payload); err == nil {
		switch {
		case payload.Operation != "" && payload.Content != "":
			return payload.Operation + ": " + payload.Content
		case payload.Content != "":
			return payload.Content
		case payload.Operation != "":
			return payload.Operation
		}
	}
	return prettyJSON(raw)
}

func extractStringField(raw json.RawMessage, field string) string {
	if len(raw) == 0 {
		return ""
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil {
		return prettyJSON(raw)
	}
	if value, ok := payload[field].(string); ok {
		return value
	}
	return prettyJSON(raw)
}

func extractNestedPrettyJSON(raw json.RawMessage, field string) string {
	if len(raw) == 0 {
		return ""
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(raw, &payload); err != nil {
		return prettyJSON(raw)
	}
	if nested, ok := payload[field]; ok {
		return prettyJSON(nested)
	}
	return prettyJSON(raw)
}

func prettyJSON(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return string(raw)
	}
	out, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return string(raw)
	}
	return string(out)
}

// maxEditPatchBytes caps the structuredPatch we pass through. Patches hold only
// changed lines + context so they're normally small, but a huge single edit
// could bloat the synced turn; past the cap we drop the patch (and the web
// falls back to the tool call's old/new strings) while keeping the file path.
const maxEditPatchBytes = 128 << 10

// editPatchFromResult pulls Claude's own computed unified diff out of an
// Edit/Write/MultiEdit toolUseResult (the record's top-level field). Returns
// ok=false for non-edit results (Bash/Read/etc., which carry no
// structuredPatch). The patch is returned verbatim so the web renders Claude's
// exact hunks; an oversized patch is dropped (nil) while ok stays true so the
// file is still reported as changed.
func editPatchFromResult(raw json.RawMessage) (filePath string, patch json.RawMessage, userModified, ok bool) {
	if len(raw) == 0 {
		return "", nil, false, false
	}
	var r struct {
		FilePath        string          `json:"filePath"`
		StructuredPatch json.RawMessage `json:"structuredPatch"`
		UserModified    bool            `json:"userModified"`
	}
	if err := json.Unmarshal(raw, &r); err != nil {
		return "", nil, false, false
	}
	if r.FilePath == "" || len(r.StructuredPatch) == 0 {
		return "", nil, false, false
	}
	if len(r.StructuredPatch) > maxEditPatchBytes {
		r.StructuredPatch = nil
	}
	return r.FilePath, r.StructuredPatch, r.UserModified, true
}

func flattenToolResultContent(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	if isJSONString(raw) {
		var s string
		if err := json.Unmarshal(raw, &s); err == nil {
			return s
		}
	}
	if isJSONArray(raw) {
		var subs []contentBlock
		if err := json.Unmarshal(raw, &subs); err == nil {
			var buf []byte
			for _, s := range subs {
				if s.Type == "text" && s.Text != "" {
					if len(buf) > 0 {
						buf = append(buf, '\n')
					}
					buf = append(buf, s.Text...)
					continue
				}
				// Fall back to a JSON dump for non-text parts so info
				// isn't silently lost.
				j, _ := json.Marshal(s)
				if len(buf) > 0 {
					buf = append(buf, '\n')
				}
				buf = append(buf, j...)
			}
			return string(buf)
		}
	}
	// Last resort: dump verbatim so the user sees something rather than
	// nothing.
	return string(raw)
}

// systemReminderRE matches Claude Code's `<system-reminder>...</system-reminder>`
// injection blocks. They appear inside tool_result text (e.g. a Read of a
// file gets a malware-warning reminder appended) and must not surface in
// the renderer — they're noise for the human and were addressed at the
// agent.
//
// Match the element plus an optional immediately-following newline, since
// reminders are typically inserted on their own line. We deliberately do
// NOT eat preceding whitespace; that would over-strip in inline cases
// (e.g. "a <reminder>x</reminder> b" should become "a  b", not "ab").
var systemReminderRE = regexp.MustCompile(`(?s)<system-reminder>.*?</system-reminder>\n?`)

func stripSystemReminders(s string) string {
	if s == "" {
		return s
	}
	return systemReminderRE.ReplaceAllString(s, "")
}

// terminalEscapeRE matches ANSI CSI escape sequences (ESC [ … final byte).
// They leak into jsonl text — most visibly claude's "/model" confirmation,
// logged as a <local-command-stdout> user record like
// "Set model to \x1b[1mOpus 4.8\x1b[22m and saved …". The ESC is
// non-printing, so the web rendered the bare "[1m"/"[22m" as garbage.
// Bash tool_result output carries them too. stripTerminalEscapes removes
// them at extraction so no consumer (web on any deploy) ever sees raw
// terminal control codes.
var terminalEscapeRE = regexp.MustCompile("\x1b\\[[0-9;:?]*[ -/]*[@-~]")

func stripTerminalEscapes(s string) string {
	if !strings.Contains(s, "\x1b") {
		return s
	}
	return terminalEscapeRE.ReplaceAllString(s, "")
}

func isJSONString(b json.RawMessage) bool {
	for _, c := range b {
		switch c {
		case ' ', '\t', '\n', '\r':
			continue
		case '"':
			return true
		default:
			return false
		}
	}
	return false
}

func isJSONArray(b json.RawMessage) bool {
	for _, c := range b {
		switch c {
		case ' ', '\t', '\n', '\r':
			continue
		case '[':
			return true
		default:
			return false
		}
	}
	return false
}
