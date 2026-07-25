// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package runner

import (
	"errors"
	"testing"
)

func TestDetectClaudeAlias(t *testing.T) {
	notFound := errors.New("not found")
	cases := []struct {
		name string
		env  map[string]string
		path map[string]string // command -> resolved path; missing means lookup fails
		want Alias
	}{
		{
			name: "env_override_wins_even_with_other_signals",
			env:  map[string]string{EnvOverride: "custom"},
			path: map[string]string{"claude": "/usr/local/bin/claude", "ccr": "/usr/local/bin/ccr"},
			want: AliasCustom,
		},
		{
			name: "env_override_normalizes_dash_form",
			env:  map[string]string{EnvOverride: "claude-ccr"},
			path: map[string]string{"claude": "/usr/local/bin/claude"},
			want: AliasClaudeCCR,
		},
		{
			name: "env_override_normalizes_bare_ccr",
			env:  map[string]string{EnvOverride: "CCR"},
			path: map[string]string{},
			want: AliasClaudeCCR,
		},
		{
			name: "env_override_invalid_falls_through",
			env:  map[string]string{EnvOverride: "garbage"},
			path: map[string]string{"claude": "/usr/local/bin/claude"},
			want: AliasClaude,
		},
		{
			name: "claude_on_path_default",
			env:  map[string]string{},
			path: map[string]string{"claude": "/usr/local/bin/claude"},
			want: AliasClaude,
		},
		{
			name: "ccr_only_when_claude_missing",
			env:  map[string]string{},
			path: map[string]string{"ccr": "/usr/local/bin/ccr"},
			want: AliasClaudeCCR,
		},
		{
			name: "claude_takes_precedence_over_ccr",
			env:  map[string]string{},
			path: map[string]string{"claude": "/usr/local/bin/claude", "ccr": "/usr/local/bin/ccr"},
			want: AliasClaude,
		},
		{
			name: "nothing_on_path_defaults_to_claude",
			env:  map[string]string{},
			path: map[string]string{},
			want: AliasClaude,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			env := func(key string) string { return tc.env[key] }
			lookPath := func(name string) (string, error) {
				if p, ok := tc.path[name]; ok {
					return p, nil
				}
				return "", notFound
			}
			if got := detectClaudeAlias(env, lookPath); got != tc.want {
				t.Fatalf("detectClaudeAlias = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestProfileAliasFor(t *testing.T) {
	profile := Profile{ClaudeAlias: AliasClaudeCCR}
	cases := []struct {
		agent string
		want  string
	}{
		{"claude-code", "claude_ccr"},
		{"codex", ""},
		{"unknown", ""},
		{"", ""},
	}
	for _, tc := range cases {
		if got := profile.AliasFor(tc.agent); got != tc.want {
			t.Errorf("AliasFor(%q) = %q, want %q", tc.agent, got, tc.want)
		}
	}

	empty := Profile{}
	if got := empty.AliasFor("claude-code"); got != "" {
		t.Errorf("empty profile AliasFor claude-code = %q, want empty", got)
	}
}
