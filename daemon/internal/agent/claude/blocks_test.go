// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package claude

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/PocklyApp/Pockly/daemon/internal/agent"
)

// leakedReminderRE matches a complete Claude-injected reminder (the form
// the daemon must strip). Bare mentions of "<system-reminder>" — without a
// matching close — are treated as legitimate tool output content.
var leakedReminderRE = regexp.MustCompile(`(?s)<system-reminder>.*?</system-reminder>`)

// blocksFixture exercises the block-producing record shapes:
//   - attachment (top-level record)
//   - user_message (string content)
//   - user_message (array content with multiple text parts)
//   - assistant_text + thinking + tool_use mixed in one assistant message
//   - tool_result preserved as its own block in user-record position
//
// Plus the noise we must ignore:
//   - sidechain assistant message
//   - tool_result with embedded <system-reminder>
const blocksFixture = `
{"type":"queue-operation","timestamp":"2026-05-17T12:00:00Z","sessionId":"s","content":"hello","operation":"enqueue"}
{"type":"attachment","uuid":"att1","timestamp":"2026-05-17T12:00:00Z","sessionId":"s","cwd":"/tmp/x","attachment":{"type":"skill_listing","content":"skill one\nskill two"}}
{"type":"user","uuid":"u1","timestamp":"2026-05-17T12:00:01Z","sessionId":"s","cwd":"/tmp/x","message":{"role":"user","content":"hello"}}
{"type":"assistant","uuid":"a1","timestamp":"2026-05-17T12:00:02Z","sessionId":"s","message":{"role":"assistant","content":[{"type":"text","text":"sure"},{"type":"thinking","thinking":"check the file first"},{"type":"tool_use","id":"tu_1","name":"Read","input":{"file_path":"/tmp/x/README"}}]}}
{"type":"user","uuid":"u2","timestamp":"2026-05-17T12:00:03Z","sessionId":"s","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_1","content":"file body\n<system-reminder>be careful</system-reminder>"}]}}
{"type":"assistant","uuid":"a2-side","timestamp":"2026-05-17T12:00:04Z","sessionId":"s","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"side"}]}}
{"type":"user","uuid":"u3","timestamp":"2026-05-17T12:00:05Z","sessionId":"s","message":{"role":"user","content":[{"type":"text","text":"part one"},{"type":"text","text":"part two"}]}}
{"type":"assistant","uuid":"a3","timestamp":"2026-05-17T12:00:06Z","sessionId":"s","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu_orphan","name":"Bash","input":{"command":"true"}}]}}
`

func writeBlocksFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	projectDir := filepath.Join(dir, "-tmp-x")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(projectDir, "s.jsonl")
	if err := os.WriteFile(path, []byte(strings.TrimSpace(blocksFixture)+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestExtractBlocks_Fixture(t *testing.T) {
	path := writeBlocksFixture(t)

	got, err := ExtractBlocks(path)
	if err != nil {
		t.Fatalf("ExtractBlocks: %v", err)
	}

	if got.Agent != "claude-code" {
		t.Errorf("agent = %q, want claude-code", got.Agent)
	}
	if got.SessionID != "s" {
		t.Errorf("session id = %q, want s", got.SessionID)
	}
	if got.Cwd != "/tmp/x" {
		t.Errorf("cwd = %q, want /tmp/x", got.Cwd)
	}

	// Expected sequence (sidechain block now preserved with IsSidechain=true):
	//   1.  meta queue-operation
	//   2.  attachment skill_listing
	//   3.  user "hello"
	//   4.  assistant text "sure"
	//   5.  thinking "check the file first"
	//   6.  tool_call Read tu_1
	//   7.  tool_result tu_1
	//   8.  assistant text "side" (sidechain)
	//   9.  user "part one"
	//  10.  user "part two"
	//  11.  tool_call Bash tu_orphan
	want := []struct {
		kind agent.BlockKind
		hint string
	}{
		{agent.BlockMeta, "enqueue: hello"},
		{agent.BlockAttachment, "skill one\nskill two"},
		{agent.BlockUserMessage, "hello"},
		{agent.BlockAssistantText, "sure"},
		{agent.BlockThinking, "check the file first"},
		{agent.BlockToolCall, "Read"},
		{agent.BlockToolResult, "file body"},
		{agent.BlockAssistantText, "side"},
		{agent.BlockUserMessage, "part one"},
		{agent.BlockUserMessage, "part two"},
		{agent.BlockToolCall, "Bash"},
	}

	if len(got.Blocks) != len(want) {
		t.Fatalf("got %d blocks, want %d. blocks: %+v", len(got.Blocks), len(want), got.Blocks)
	}

	for i, w := range want {
		b := got.Blocks[i]
		if b.Kind != w.kind {
			t.Errorf("block[%d].kind = %q, want %q", i, b.Kind, w.kind)
		}
		switch b.Kind {
		case agent.BlockUserMessage, agent.BlockAssistantText, agent.BlockThinking, agent.BlockAttachment, agent.BlockMeta:
			if b.Text != w.hint {
				t.Errorf("block[%d].text = %q, want %q", i, b.Text, w.hint)
			}
		case agent.BlockToolCall:
			if b.Tool != w.hint {
				t.Errorf("block[%d].tool = %q, want %q", i, b.Tool, w.hint)
			}
		case agent.BlockToolResult:
			if !strings.Contains(b.Result, w.hint) {
				t.Errorf("block[%d].result = %q, want to contain %q", i, b.Result, w.hint)
			}
		}
	}

	meta := got.Blocks[0]
	if meta.MetaType != "queue-operation" {
		t.Errorf("meta.MetaType = %q, want queue-operation", meta.MetaType)
	}

	attachment := got.Blocks[1]
	if attachment.AttachmentType != "skill_listing" {
		t.Errorf("attachment.AttachmentType = %q, want skill_listing", attachment.AttachmentType)
	}

	read := got.Blocks[5]
	if read.ID != "tu_1" {
		t.Errorf("Read.ID = %q, want tu_1", read.ID)
	}
	if read.HasResult {
		t.Errorf("Read.HasResult = true, want false now that tool_result is separate")
	}
	if read.Result != "" {
		t.Errorf("Read.Result = %q, want empty when tool_result is separate", read.Result)
	}

	// Check tool_result ordering and system-reminder strip.
	result := got.Blocks[6]
	if result.Kind != agent.BlockToolResult {
		t.Fatalf("result.Kind = %q, want tool_result", result.Kind)
	}
	if result.ID != "tu_1" {
		t.Errorf("result.ID = %q, want tu_1", result.ID)
	}
	if !result.HasResult {
		t.Errorf("result.HasResult = false, want true")
	}
	if !strings.Contains(result.Result, "file body") {
		t.Errorf("result.Result missing real content: %q", result.Result)
	}
	if strings.Contains(result.Result, "system-reminder") {
		t.Errorf("result.Result contained system-reminder injection: %q", result.Result)
	}
	if strings.Contains(result.Result, "be careful") {
		t.Errorf("result.Result still contained reminder body: %q", result.Result)
	}

	// Sidechain block: text preserved, IsSidechain flag set. Fixture has
	// no parentUuid so ParentToolUseID stays empty — TestExtractBlocks_SubagentThreading
	// covers the resolution path.
	side := got.Blocks[7]
	if !side.IsSidechain {
		t.Errorf("sidechain block[7].IsSidechain = false, want true")
	}
	if side.Text != "side" {
		t.Errorf("sidechain block[7].Text = %q, want \"side\"", side.Text)
	}

	// Orphaned tool_use should still have HasResult=false.
	bash := got.Blocks[10]
	if bash.HasResult {
		t.Errorf("orphan Bash.HasResult = true, want false")
	}
	if bash.Result != "" {
		t.Errorf("orphan Bash.Result = %q, want empty", bash.Result)
	}
}

// TestExtractBlocks_SubagentThreading verifies that a sidechain assistant
// record whose parentUuid descends from a Task tool_use record gets its
// ParentToolUseID resolved to that Task's tool_use id, so the web
// renderer can nest the subagent's steps under the right card.
func TestExtractBlocks_SubagentThreading(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "task.jsonl")
	body := strings.TrimSpace(`
{"type":"user","uuid":"u-start","timestamp":"2026-05-20T10:00:00Z","sessionId":"s","cwd":"/tmp/x","message":{"role":"user","content":"spawn an agent"}}
{"type":"assistant","uuid":"a-task","parentUuid":"u-start","timestamp":"2026-05-20T10:00:01Z","sessionId":"s","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu_task","name":"Task","input":{"description":"search","prompt":"do work"}}]}}
{"type":"assistant","uuid":"a-sub-1","parentUuid":"a-task","timestamp":"2026-05-20T10:00:02Z","sessionId":"s","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"sub starting"}]}}
{"type":"assistant","uuid":"a-sub-2","parentUuid":"a-sub-1","timestamp":"2026-05-20T10:00:03Z","sessionId":"s","isSidechain":true,"message":{"role":"assistant","content":[{"type":"text","text":"sub continuing"}]}}
`) + "\n"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := ExtractBlocks(path)
	if err != nil {
		t.Fatal(err)
	}

	var subBlocks []agent.Block
	for _, b := range got.Blocks {
		if b.IsSidechain {
			subBlocks = append(subBlocks, b)
		}
	}
	if len(subBlocks) != 2 {
		t.Fatalf("got %d sidechain blocks, want 2: %+v", len(subBlocks), subBlocks)
	}
	for i, b := range subBlocks {
		if b.ParentToolUseID != "tu_task" {
			t.Errorf("sub[%d].ParentToolUseID = %q, want tu_task", i, b.ParentToolUseID)
		}
	}
}

// TestExtractBlocks_UsageAttachment verifies that token usage from an
// assistant message envelope is attached to the last block produced from
// that message, so the web can show a context-window meter.
func TestExtractBlocks_UsageAttachment(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "usage.jsonl")
	body := strings.TrimSpace(`
{"type":"assistant","uuid":"a-usage","timestamp":"2026-05-20T10:00:00Z","sessionId":"s","message":{"role":"assistant","content":[{"type":"text","text":"hello"}],"usage":{"input_tokens":1234,"output_tokens":56,"cache_read_input_tokens":7800}}}
`) + "\n"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := ExtractBlocks(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Blocks) != 1 {
		t.Fatalf("got %d blocks, want 1", len(got.Blocks))
	}
	b := got.Blocks[0]
	if b.InputTokens != 1234 || b.OutputTokens != 56 || b.CacheReadTokens != 7800 {
		t.Errorf("usage = %+v, want {1234, 56, _, 7800}", b)
	}
}

// TestExtractBlocks_ImageBlock verifies that a user image content part is
// emitted as a distinct BlockImage carrying media_type + base64 data.
func TestExtractBlocks_ImageBlock(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "image.jsonl")
	body := strings.TrimSpace(`
{"type":"user","uuid":"u-img","timestamp":"2026-05-20T10:00:00Z","sessionId":"s","message":{"role":"user","content":[{"type":"text","text":"look at this"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"AAAA"}}]}}
`) + "\n"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := ExtractBlocks(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Blocks) != 2 {
		t.Fatalf("got %d blocks, want 2: %+v", len(got.Blocks), got.Blocks)
	}
	img := got.Blocks[1]
	if img.Kind != agent.BlockImage {
		t.Fatalf("blocks[1].Kind = %q, want image", img.Kind)
	}
	if img.ImageMediaType != "image/png" {
		t.Errorf("img.ImageMediaType = %q, want image/png", img.ImageMediaType)
	}
	if img.ImageData != "AAAA" {
		t.Errorf("img.ImageData = %q, want AAAA", img.ImageData)
	}
}

func TestExtractBlocks_WebSearchToolUseAndResult(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "websearch.jsonl")
	body := strings.TrimSpace(`
{"type":"assistant","uuid":"a-web","timestamp":"2026-05-28T15:25:13Z","sessionId":"s","message":{"role":"assistant","content":[{"type":"tool_use","id":"call_web","name":"WebSearch","input":{"query":"open-design open source project"}}]}}
{"type":"user","uuid":"u-web","timestamp":"2026-05-28T15:25:42Z","sessionId":"s","message":{"role":"user","content":[{"tool_use_id":"call_web","type":"tool_result","content":"Web search results for query: \"open-design open source project\"","is_error":false}]}}
`)
	if err := os.WriteFile(path, []byte(body+"\n"), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	got, err := ExtractBlocks(path)
	if err != nil {
		t.Fatalf("ExtractBlocks: %v", err)
	}
	if len(got.Blocks) != 2 {
		t.Fatalf("got %d blocks, want 2: %+v", len(got.Blocks), got.Blocks)
	}
	call := got.Blocks[0]
	if call.Kind != agent.BlockToolCall || call.Tool != "WebSearch" || call.ID != "call_web" {
		t.Fatalf("tool call = %+v", call)
	}
	var input map[string]string
	if err := json.Unmarshal(call.Input, &input); err != nil {
		t.Fatalf("unmarshal input: %v", err)
	}
	if input["query"] != "open-design open source project" {
		t.Fatalf("tool input = %+v", input)
	}
	result := got.Blocks[1]
	if result.Kind != agent.BlockToolResult || result.ID != "call_web" || !result.HasResult || result.IsError {
		t.Fatalf("tool result = %+v", result)
	}
	if !strings.Contains(result.Result, "Web search results") {
		t.Fatalf("result text = %q", result.Result)
	}
}

func TestExtractBlocksMergesAssistantTextWithinMessage(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "merge.jsonl")
	body := strings.TrimSpace(`
{"type":"assistant","uuid":"a-merge","timestamp":"2026-05-20T10:00:00Z","sessionId":"s","message":{"role":"assistant","content":[{"type":"text","text":"first"},{"type":"text","text":"second"},{"type":"text","text":"third"}]}}
{"type":"assistant","uuid":"a-split","timestamp":"2026-05-20T10:00:01Z","sessionId":"s","message":{"role":"assistant","content":[{"type":"text","text":"before"},{"type":"tool_use","id":"tu_x","name":"Bash","input":{}},{"type":"text","text":"after"}]}}
`) + "\n"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}

	got, err := ExtractBlocks(path)
	if err != nil {
		t.Fatal(err)
	}
	// Expect: assistant_text "first\n\nsecond\n\nthird", assistant_text "before", tool_call Bash, assistant_text "after"
	if len(got.Blocks) != 4 {
		t.Fatalf("got %d blocks, want 4: %+v", len(got.Blocks), got.Blocks)
	}
	if got.Blocks[0].Kind != agent.BlockAssistantText || got.Blocks[0].Text != "first\n\nsecond\n\nthird" {
		t.Errorf("merged block = %+v", got.Blocks[0])
	}
	if got.Blocks[1].Kind != agent.BlockAssistantText || got.Blocks[1].Text != "before" {
		t.Errorf("pre-tool text = %+v", got.Blocks[1])
	}
	if got.Blocks[2].Kind != agent.BlockToolCall {
		t.Errorf("tool_call missing at index 2: %+v", got.Blocks[2])
	}
	if got.Blocks[3].Kind != agent.BlockAssistantText || got.Blocks[3].Text != "after" {
		t.Errorf("post-tool text = %+v", got.Blocks[3])
	}
}

func TestStripSystemReminders(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"plain text", "plain text"},
		{"before<system-reminder>x</system-reminder>after", "beforeafter"},
		{"a\n<system-reminder>\nmulti\nline\n</system-reminder>\nb", "a\nb"},
		{"<system-reminder>only</system-reminder>", ""},
		{"<system-reminder>one</system-reminder>middle<system-reminder>two</system-reminder>", "middle"},
	}
	for _, c := range cases {
		got := stripSystemReminders(c.in)
		if got != c.want {
			t.Errorf("stripSystemReminders(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestStripTerminalEscapes(t *testing.T) {
	cases := []struct{ in, want string }{
		{"plain text", "plain text"},
		{"Set model to \x1b[1mOpus 4.8\x1b[22m and saved", "Set model to Opus 4.8 and saved"},
		{"a\x1b[2Gb\x1b[5Gc", "abc"},     // CHA positioning
		{"\x1b[31mred\x1b[0m done", "red done"},
		{"no escapes", "no escapes"},
	}
	for _, c := range cases {
		if got := stripTerminalEscapes(c.in); got != c.want {
			t.Errorf("stripTerminalEscapes(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

// TestExtractBlocksStripsModelSwitchANSI guards the "/model confirmation shows
// garbled [1m…[22m on web" regression. claude logs the confirmation as a USER
// record whose <local-command-stdout> content carries raw ANSI bold (the
// string-content branch of blocksForMessage). The extracted turn text must be
// de-escaped before it syncs, so no web (any deploy) renders raw escapes.
func TestExtractBlocksStripsModelSwitchANSI(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "model.jsonl")
	// Build via json.Marshal so the real ESC byte (\x1b) becomes the exact
	// \u001b JSON escape the real jsonl stores (a raw ESC in JSON is invalid).
	content := "<local-command-stdout>Set model to \x1b[1manthropic-compatible-fast\x1b[22m and saved as your default for new sessions</local-command-stdout>"
	rec := map[string]any{
		"type": "user", "uuid": "u1", "timestamp": "2026-06-01T00:00:00Z", "sessionId": "s",
		"message": map[string]any{"role": "user", "content": content},
	}
	line, err := json.Marshal(rec)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, append(line, '\n'), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := ExtractBlocks(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Blocks) != 1 {
		t.Fatalf("got %d blocks, want 1: %+v", len(got.Blocks), got.Blocks)
	}
	text := got.Blocks[0].Text
	if strings.ContainsRune(text, '\x1b') || strings.Contains(text, "[1m") || strings.Contains(text, "[22m") {
		t.Errorf("extracted text still carries terminal escapes: %q", text)
	}
	if !strings.Contains(text, "Set model to anthropic-compatible-fast and saved") {
		t.Errorf("extracted text = %q, want the de-escaped confirmation", text)
	}
}

func TestExtractBlocks_RealData(t *testing.T) {
	home, err := DefaultHome()
	if err != nil || isMissing(home) {
		t.Skip("no claude home")
	}
	projects, err := ListProjects(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(projects) == 0 {
		t.Skip("no projects")
	}
	for _, p := range projects {
		if len(p.Sessions) == 0 {
			continue
		}
		for _, sess := range p.Sessions {
			data, err := ExtractBlocks(sess.Path)
			if err != nil {
				t.Errorf("%s: %v", sess.Path, err)
				continue
			}
			counts := map[agent.BlockKind]int{}
			toolsTotal := 0
			toolResults := 0
			for _, b := range data.Blocks {
				counts[b.Kind]++
				if b.Kind == agent.BlockToolCall {
					toolsTotal++
				}
				if b.Kind == agent.BlockToolResult {
					toolResults++
					// A *complete* <system-reminder>...</system-reminder>
					// pair is what Claude Code injects and what we must
					// strip. Bare mentions of the string can legitimately
					// appear in tool output (e.g. a chrome-devtools page
					// snapshot of the agent's own UI), so we don't flag
					// those.
					if leakedReminderRE.MatchString(b.Result) {
						idx := leakedReminderRE.FindStringIndex(b.Result)[0]
						start := idx - 60
						if start < 0 {
							start = 0
						}
						end := idx + 200
						if end > len(b.Result) {
							end = len(b.Result)
						}
						t.Errorf("%s: leaked system-reminder in tool result %q. context: …%q…",
							sess.ID, b.ID, b.Result[start:end])
					}
				}
			}
			t.Logf("%s [%s]: blocks=%d (user=%d, asst=%d, thinking=%d, tool=%d, tool_result=%d, attachment=%d, meta=%d)",
				p.Cwd, sess.ID, len(data.Blocks),
				counts[agent.BlockUserMessage], counts[agent.BlockAssistantText],
				counts[agent.BlockThinking], toolsTotal, toolResults, counts[agent.BlockAttachment], counts[agent.BlockMeta])
		}
	}
}

func isMissing(p string) bool {
	_, err := os.Stat(p)
	return err != nil
}

// Sanity: produced JSON deserializes back to something the renderer can use.
func TestBlock_JSONRoundtrip(t *testing.T) {
	b := agent.Block{
		Kind:      agent.BlockToolCall,
		Tool:      "Read",
		ID:        "tu_1",
		Input:     json.RawMessage(`{"file_path":"/x"}`),
		Result:    "ok",
		HasResult: true,
		Timestamp: "2026-05-17T12:00:00Z",
	}
	raw, err := json.Marshal(b)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), `"kind":"tool_call"`) {
		t.Errorf("missing kind: %s", raw)
	}
	if strings.Contains(string(raw), `"is_error":`) {
		t.Errorf("expected is_error omitempty, got: %s", raw)
	}
	var back agent.Block
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatal(err)
	}
	if back.Tool != "Read" {
		t.Errorf("roundtrip tool = %q, want Read", back.Tool)
	}
}

// TestExtractBlocks_EditPatch verifies that an Edit/Write tool_result record's
// top-level toolUseResult.structuredPatch is surfaced on the BlockToolResult
// (EditFilePath/EditPatch/EditUserModified), while a non-edit result (Bash)
// carries none of those.
func TestExtractBlocks_EditPatch(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "edit.jsonl")
	body := strings.TrimSpace(`
{"type":"user","uuid":"u-edit","timestamp":"2026-06-01T00:00:00Z","sessionId":"s","message":{"role":"user","content":[{"tool_use_id":"tu_edit","type":"tool_result","content":"ok"}]},"toolUseResult":{"filePath":"/proj/styles.css","oldString":"a","newString":"b","originalFile":null,"userModified":true,"replaceAll":false,"structuredPatch":[{"oldStart":3719,"oldLines":6,"newStart":3719,"newLines":7,"lines":[" pre {","+  overscroll-behavior-x: contain;"]}]}}
{"type":"user","uuid":"u-bash","timestamp":"2026-06-01T00:00:01Z","sessionId":"s","message":{"role":"user","content":[{"tool_use_id":"tu_bash","type":"tool_result","content":"hi"}]},"toolUseResult":{"stdout":"hi","stderr":"","interrupted":false,"isImage":false}}
`) + "\n"
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := ExtractBlocks(path)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Blocks) != 2 {
		t.Fatalf("got %d blocks, want 2: %+v", len(got.Blocks), got.Blocks)
	}
	edit := got.Blocks[0]
	if edit.Kind != agent.BlockToolResult || edit.ID != "tu_edit" {
		t.Fatalf("blocks[0] = %+v", edit)
	}
	if edit.EditFilePath != "/proj/styles.css" {
		t.Errorf("EditFilePath = %q, want /proj/styles.css", edit.EditFilePath)
	}
	if !edit.EditUserModified {
		t.Errorf("EditUserModified = false, want true")
	}
	if len(edit.EditPatch) == 0 || !strings.Contains(string(edit.EditPatch), "overscroll-behavior-x") {
		t.Errorf("EditPatch missing/empty: %q", string(edit.EditPatch))
	}
	var hunks []map[string]any
	if err := json.Unmarshal(edit.EditPatch, &hunks); err != nil || len(hunks) != 1 {
		t.Errorf("EditPatch not a 1-hunk array: err=%v hunks=%d", err, len(hunks))
	}

	bash := got.Blocks[1]
	if bash.Kind != agent.BlockToolResult || bash.ID != "tu_bash" {
		t.Fatalf("blocks[1] = %+v", bash)
	}
	if bash.EditFilePath != "" || len(bash.EditPatch) != 0 || bash.EditUserModified {
		t.Errorf("Bash result wrongly carries edit fields: %+v", bash)
	}
}

func TestEditPatchFromResult(t *testing.T) {
	editRaw := json.RawMessage(`{"filePath":"/p/x.go","userModified":true,"structuredPatch":[{"oldStart":1,"oldLines":0,"newStart":1,"newLines":1,"lines":["+hi"]}]}`)
	fp, patch, userMod, ok := editPatchFromResult(editRaw)
	if !ok || fp != "/p/x.go" || !userMod || len(patch) == 0 {
		t.Fatalf("edit result: ok=%v fp=%q userMod=%v patchLen=%d", ok, fp, userMod, len(patch))
	}

	// Bash-style result: no structuredPatch → not an edit.
	if _, _, _, ok := editPatchFromResult(json.RawMessage(`{"stdout":"hi","stderr":""}`)); ok {
		t.Error("bash result should not be treated as an edit")
	}
	// filePath but empty patch → not an edit.
	if _, _, _, ok := editPatchFromResult(json.RawMessage(`{"filePath":"/p/x.go"}`)); ok {
		t.Error("filePath without structuredPatch should not be an edit")
	}
	// empty input → not an edit.
	if _, _, _, ok := editPatchFromResult(nil); ok {
		t.Error("empty result should not be an edit")
	}

	// Oversized patch → patch dropped (nil) but still reported as a changed file.
	bigLine := strings.Repeat("x", maxEditPatchBytes+10)
	bigRaw := json.RawMessage(`{"filePath":"/p/big.go","userModified":false,"structuredPatch":[{"lines":["+` + bigLine + `"]}]}`)
	fp, patch, _, ok = editPatchFromResult(bigRaw)
	if !ok || fp != "/p/big.go" {
		t.Fatalf("oversized: ok=%v fp=%q", ok, fp)
	}
	if patch != nil {
		t.Errorf("oversized patch should be dropped, got %d bytes", len(patch))
	}
}
