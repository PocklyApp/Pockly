// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package control

import (
	"os"
	"strings"
	"testing"
)

// extractAttachmentPaths pulls the @<path> references writeInjectAttachments
// appended, so a test can read the files back and clean them up.
func extractAttachmentPaths(text string) []string {
	var paths []string
	for _, line := range strings.Split(text, "\n") {
		if strings.HasPrefix(line, "@") {
			paths = append(paths, strings.TrimPrefix(line, "@"))
		}
	}
	return paths
}

func TestWriteInjectAttachments(t *testing.T) {
	req := InjectRequest{
		RequestID: "inj_test123",
		Text:      "describe these",
		Files: []InjectFile{
			{Filename: "shot.png", MimeType: "image/png", Data: []byte("PNGDATA")},
			{Filename: "../../etc/passwd", MimeType: "text/plain", Data: []byte("hello")},
		},
	}
	out, err := writeInjectAttachments(req)
	if err != nil {
		t.Fatalf("writeInjectAttachments: %v", err)
	}
	if !strings.HasPrefix(out, "describe these\n\n") {
		t.Fatalf("expected original prompt preserved, got %q", out)
	}
	if strings.Contains(out, "../") {
		t.Fatalf("path traversal not sanitized: %q", out)
	}
	paths := extractAttachmentPaths(out)
	if len(paths) != 2 {
		t.Fatalf("expected 2 @path refs, got %d in %q", len(paths), out)
	}
	defer func() {
		for _, p := range paths {
			_ = os.Remove(p)
		}
	}()
	wantData := map[string][]byte{"shot.png": []byte("PNGDATA"), "passwd": []byte("hello")}
	for _, p := range paths {
		data, rerr := os.ReadFile(p)
		if rerr != nil {
			t.Fatalf("attachment not written at %s: %v", p, rerr)
		}
		base := p[strings.LastIndex(p, "/")+1:]
		if want, ok := wantData[base]; ok && string(data) != string(want) {
			t.Fatalf("attachment %s = %q, want %q", base, data, want)
		}
	}
}

func TestWriteInjectAttachmentsEmptyCaption(t *testing.T) {
	req := InjectRequest{
		RequestID: "inj_only_file",
		Text:      "",
		Files:     []InjectFile{{Filename: "a.txt", Data: []byte("x")}},
	}
	out, err := writeInjectAttachments(req)
	if err != nil {
		t.Fatalf("writeInjectAttachments: %v", err)
	}
	paths := extractAttachmentPaths(out)
	if len(paths) != 1 {
		t.Fatalf("expected 1 ref, got %q", out)
	}
	for _, p := range paths {
		_ = os.Remove(p)
	}
	// No leading blank lines when there was no caption.
	if strings.HasPrefix(out, "\n") {
		t.Fatalf("expected no leading newline for caption-less attachment, got %q", out)
	}
}

func TestSafeAttachmentName(t *testing.T) {
	cases := map[string]string{
		"plain.txt":          "plain.txt",
		"../../evil.sh":      "evil.sh",
		"a/b/c.png":          "c.png",
		"":                   "attachment-1",
		"weird\x00name.json": "weird_name.json",
	}
	for in, want := range cases {
		if got := safeAttachmentName(in, 0); got != want {
			t.Errorf("safeAttachmentName(%q) = %q, want %q", in, got, want)
		}
	}
}
