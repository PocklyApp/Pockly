// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"os"
	"reflect"
	"testing"
)

// TestSplitWrapperArgs covers the transparent-alias contract: leading
// wrapper flags are consumed, and the first claude-owned token (a claude
// flag, a positional, or an explicit `--`) begins claude's argv. See the
// regression that motivated it: `claude --resume <id>` via the shell alias
// used to trip Go's flag parser with "flag provided but not defined:
// -resume".
func TestSplitWrapperArgs(t *testing.T) {
	cases := []struct {
		name        string
		argv        []string
		wantWrapper []string
		wantClaude  []string
	}{
		{
			name:        "bare invocation",
			argv:        nil,
			wantWrapper: nil,
			wantClaude:  nil,
		},
		{
			name:        "claude flag with no separator forwards",
			argv:        []string{"--resume", "abc-123"},
			wantWrapper: []string{},
			wantClaude:  []string{"--resume", "abc-123"},
		},
		{
			name:        "short claude flag forwards",
			argv:        []string{"-r", "abc-123"},
			wantWrapper: []string{},
			wantClaude:  []string{"-r", "abc-123"},
		},
		{
			name:        "wrapper value flag then claude args",
			argv:        []string{"--real", "/usr/bin/claude", "--resume", "abc"},
			wantWrapper: []string{"--real", "/usr/bin/claude"},
			wantClaude:  []string{"--resume", "abc"},
		},
		{
			name:        "single-dash wrapper value flag (playwright form)",
			argv:        []string{"-real", "/usr/local/bin/fake-claude"},
			wantWrapper: []string{"-real", "/usr/local/bin/fake-claude"},
			wantClaude:  []string{},
		},
		{
			name:        "inline value flag",
			argv:        []string{"--real=/usr/bin/claude", "--resume", "abc"},
			wantWrapper: []string{"--real=/usr/bin/claude"},
			wantClaude:  []string{"--resume", "abc"},
		},
		{
			name:        "bool flag then claude args",
			argv:        []string{"--alt-screen", "--resume", "abc"},
			wantWrapper: []string{"--alt-screen"},
			wantClaude:  []string{"--resume", "abc"},
		},
		{
			name:        "bool flag with inline value",
			argv:        []string{"--register=false", "--resume", "abc"},
			wantWrapper: []string{"--register=false"},
			wantClaude:  []string{"--resume", "abc"},
		},
		{
			name:        "explicit separator is dropped",
			argv:        []string{"--alt-screen", "--", "--resume", "abc"},
			wantWrapper: []string{"--alt-screen"},
			wantClaude:  []string{"--resume", "abc"},
		},
		{
			name:        "separator with no wrapper flags",
			argv:        []string{"--", "--help"},
			wantWrapper: []string{},
			wantClaude:  []string{"--help"},
		},
		{
			name:        "test_scenario form: value + bools + separator",
			argv:        []string{"--real", "/tmp/fake", "--register=false", "--no-indicator", "--pass", "--", "--help"},
			wantWrapper: []string{"--real", "/tmp/fake", "--register=false", "--no-indicator", "--pass"},
			wantClaude:  []string{"--help"},
		},
		{
			name:        "positional starts claude argv",
			argv:        []string{"resume", "abc"},
			wantWrapper: []string{},
			wantClaude:  []string{"resume", "abc"},
		},
		{
			name:        "dangling value flag left for fs.Parse",
			argv:        []string{"--real"},
			wantWrapper: []string{"--real"},
			wantClaude:  []string{},
		},
		{
			// Regression: --debug is a real claude flag (`-d, --debug
			// [filter]`) and must NOT be owned by the wrapper. If the
			// wrapper claimed it, `claude --debug` would be swallowed and
			// `claude --debug=api,hooks` would hard-error on bool parse.
			name:        "claude --debug is forwarded, not consumed",
			argv:        []string{"--debug"},
			wantWrapper: []string{},
			wantClaude:  []string{"--debug"},
		},
		{
			name:        "claude --debug=filter is forwarded",
			argv:        []string{"--debug=api,hooks", "--resume", "x"},
			wantWrapper: []string{},
			wantClaude:  []string{"--debug=api,hooks", "--resume", "x"},
		},
		{
			name:        "short -d is forwarded",
			argv:        []string{"-d", "api"},
			wantWrapper: []string{},
			wantClaude:  []string{"-d", "api"},
		},
		{
			// A malformed wrapper-flag value stops the wrapper-flag run at
			// that token (splitWrapperArgs is value-shape-agnostic); fs.Parse
			// later swallows the bad value. Trailing claude args still
			// survive because they sit past the wrapper-flag prefix.
			name:        "malformed bool value keeps trailing claude args",
			argv:        []string{"--register=maybe", "--resume", "x"},
			wantWrapper: []string{"--register=maybe"},
			wantClaude:  []string{"--resume", "x"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			gotWrapper, gotClaude := splitWrapperArgs(tc.argv)
			if !argsEqual(gotWrapper, tc.wantWrapper) {
				t.Errorf("wrapperArgs = %#v, want %#v", gotWrapper, tc.wantWrapper)
			}
			if !argsEqual(gotClaude, tc.wantClaude) {
				t.Errorf("claudeArgs = %#v, want %#v", gotClaude, tc.wantClaude)
			}
		})
	}
}

// argsEqual treats nil and empty slices as equal — splitWrapperArgs may
// return either depending on where the slice was cut, and callers don't
// distinguish them.
func argsEqual(a, b []string) bool {
	if len(a) == 0 && len(b) == 0 {
		return true
	}
	return reflect.DeepEqual(a, b)
}

// TestWrapperFlagName covers the token-shape parsing that splitWrapperArgs
// relies on to tell wrapper flags from claude flags and positionals.
func TestWrapperFlagName(t *testing.T) {
	cases := []struct {
		tok        string
		wantName   string
		wantInline bool
	}{
		{"--real", "real", false},
		{"-real", "real", false},
		{"--real=/x", "real", true},
		{"-r=x", "r", true},
		{"--resume", "resume", false},
		{"foo", "", false},
		{"-", "", false},
		{"--", "", false},
		{"", "", false},
	}
	for _, tc := range cases {
		t.Run(tc.tok, func(t *testing.T) {
			name, inline := wrapperFlagName(tc.tok)
			if name != tc.wantName || inline != tc.wantInline {
				t.Errorf("wrapperFlagName(%q) = (%q, %v), want (%q, %v)",
					tc.tok, name, inline, tc.wantName, tc.wantInline)
			}
		})
	}
}

// TestParseArgsForwardsClaudeFlags is the end-to-end guard for the alias
// regression: parseArgs must route claude flags into cfg.args untouched
// while still binding recognized wrapper flags.
func TestParseArgsForwardsClaudeFlags(t *testing.T) {
	oldArgs := os.Args
	defer func() { os.Args = oldArgs }()

	os.Args = []string{"pockly-claude-wrapper", "--alt-screen", "--resume", "sid-42"}
	cfg := parseArgs()
	if !cfg.altScreen {
		t.Errorf("altScreen = false, want true (wrapper flag should bind)")
	}
	want := []string{"--resume", "sid-42"}
	if !reflect.DeepEqual(cfg.args, want) {
		t.Errorf("cfg.args = %#v, want %#v", cfg.args, want)
	}
}

// TestParseArgsForwardsDebug guards the flag-name collision fix: --debug is
// a real claude flag (`-d, --debug [filter]`), so the wrapper must forward
// it rather than consume it as wrapper diagnostics (which are gated by the
// POCKLY_WRAPPER_DEBUG env var instead). Regression: a --debug wrapper flag
// used to swallow `claude --debug` and hard-exit `claude --debug=api,hooks`.
func TestParseArgsForwardsDebug(t *testing.T) {
	oldArgs := os.Args
	defer func() { os.Args = oldArgs }()

	for _, tc := range []struct {
		name string
		argv []string
		want []string
	}{
		{"bare debug", []string{"--debug"}, []string{"--debug"}},
		{"debug with filter value", []string{"--debug=api,hooks"}, []string{"--debug=api,hooks"}},
		{"short debug", []string{"-d", "api"}, []string{"-d", "api"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			os.Args = append([]string{"pockly-claude-wrapper"}, tc.argv...)
			cfg := parseArgs()
			if cfg.debug {
				t.Errorf("cfg.debug = true; --debug must NOT enable wrapper diagnostics (env-gated only)")
			}
			if !reflect.DeepEqual(cfg.args, tc.want) {
				t.Errorf("cfg.args = %#v, want %#v", cfg.args, tc.want)
			}
		})
	}
}

// TestParseArgsMalformedWrapperValueDoesNotExit guards the ContinueOnError
// fix: a malformed value on a genuine wrapper flag (e.g. --register=maybe)
// must not hard-exit the process — claude never gets a chance otherwise.
// parseArgs swallows the parse error; if flag.ExitOnError regressed, the
// process would os.Exit(2) here and the test binary would fail.
//
// It also guards against leaking leftover wrapper flags to claude: when
// fs.Parse aborts mid-argv, Go's flag package leaves fs.Args() pointing at
// the *unparsed wrapper tokens* (e.g. --pass), not claude argv. Since
// splitWrapperArgs already owns the wrapper/claude boundary, cfg.args must
// come only from its claudeArgs — never fs.Args() — or those wrapper tokens
// bleed through to claude.
func TestParseArgsMalformedWrapperValueDoesNotExit(t *testing.T) {
	oldArgs := os.Args
	defer func() { os.Args = oldArgs }()

	for _, tc := range []struct {
		name string
		argv []string
		want []string
	}{
		{
			name: "malformed then claude args",
			argv: []string{"--register=maybe", "--resume", "x"},
			want: []string{"--resume", "x"},
		},
		{
			// Regression: --pass is a trailing WRAPPER flag after the
			// failing token. It must not leak into claude argv.
			name: "malformed then trailing wrapper flag then claude args",
			argv: []string{"--register=maybe", "--pass", "--resume", "x"},
			want: []string{"--resume", "x"},
		},
		{
			name: "malformed bool then trailing wrapper flag",
			argv: []string{"--clear=bad", "--no-indicator", "--resume", "y"},
			want: []string{"--resume", "y"},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			os.Args = append([]string{"pockly-claude-wrapper"}, tc.argv...)
			cfg := parseArgs()
			if !reflect.DeepEqual(cfg.args, tc.want) {
				t.Errorf("cfg.args = %#v, want %#v (leaked wrapper flags?)", cfg.args, tc.want)
			}
		})
	}
}

// TestWrapperDebugEnabledEnvGate documents the replacement diagnostics
// switch so a future refactor doesn't silently drop it.
func TestWrapperDebugEnabledEnvGate(t *testing.T) {
	t.Setenv("POCKLY_WRAPPER_DEBUG", "1")
	if !wrapperDebugEnabled() {
		t.Error("POCKLY_WRAPPER_DEBUG=1 should enable wrapper debug")
	}
	t.Setenv("POCKLY_WRAPPER_DEBUG", "")
	if wrapperDebugEnabled() {
		t.Error("empty POCKLY_WRAPPER_DEBUG should disable wrapper debug")
	}
}

func TestIndicatorDisabledByDefault(t *testing.T) {
	oldArgs := os.Args
	defer func() { os.Args = oldArgs }()

	t.Setenv("POCKLY_WRAPPER_INDICATOR", "")
	os.Args = []string{"pockly-claude-wrapper"}
	if cfg := parseArgs(); !cfg.noIndicator {
		t.Error("bottom-right indicator must be disabled by default")
	}

	t.Setenv("POCKLY_WRAPPER_INDICATOR", "1")
	os.Args = []string{"pockly-claude-wrapper"}
	if cfg := parseArgs(); cfg.noIndicator {
		t.Error("POCKLY_WRAPPER_INDICATOR=1 should opt into the legacy indicator")
	}

	os.Args = []string{"pockly-claude-wrapper", "--no-indicator"}
	if cfg := parseArgs(); !cfg.noIndicator {
		t.Error("--no-indicator must override the indicator opt-in")
	}
}
