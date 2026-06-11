// Copyright 2026 Pockly contributors
// SPDX-License-Identifier: Apache-2.0

package control

import (
	"strings"
	"sync"
	"time"
)

type terminalEventBatcher struct {
	mu            sync.Mutex
	send          func(TerminalEvent)
	shouldSend    func(TerminalEvent) bool
	flushEvery    time.Duration
	maxBytes      int
	ringMaxBytes  int
	ringMaxAge    time.Duration
	pending       map[string]*terminalEventBatch
	rings         map[string][]terminalRingEntry
	ringTruncated map[string]bool
	deliveredSeq  map[string]int64
	closed        bool
}

type terminalEventBatch struct {
	event    TerminalEvent
	bytes    int
	firstSeq int64
	lastSeq  int64
	timer    *time.Timer
}

type terminalRingEntry struct {
	at       time.Time
	bytes    int
	payload  string
	seqStart int64
	seqEnd   int64
}

func newTerminalEventBatcher(send func(TerminalEvent), flushEvery time.Duration, maxBytes, ringMaxBytes int, ringMaxAge time.Duration) *terminalEventBatcher {
	if flushEvery <= 0 {
		flushEvery = 200 * time.Millisecond
	}
	if maxBytes <= 0 {
		maxBytes = 16 * 1024
	}
	if ringMaxBytes <= 0 {
		ringMaxBytes = 1024 * 1024
	}
	if ringMaxAge <= 0 {
		ringMaxAge = 5 * time.Minute
	}
	return &terminalEventBatcher{
		send:          send,
		flushEvery:    flushEvery,
		maxBytes:      maxBytes,
		ringMaxBytes:  ringMaxBytes,
		ringMaxAge:    ringMaxAge,
		pending:       map[string]*terminalEventBatch{},
		rings:         map[string][]terminalRingEntry{},
		ringTruncated: map[string]bool{},
		deliveredSeq:  map[string]int64{},
	}
}

func (b *terminalEventBatcher) SetShouldSend(fn func(TerminalEvent) bool) {
	if b == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.shouldSend = fn
}

func (b *terminalEventBatcher) Add(evt TerminalEvent) {
	if b == nil {
		return
	}
	if evt.Kind != "text_delta" || evt.Payload == "" {
		b.FlushTerminal(evt.TerminalSessionID)
		b.emit(evt)
		return
	}
	key := evt.TerminalSessionID
	if key == "" {
		b.emit(evt)
		return
	}
	var toSend []TerminalEvent
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return
	}
	entry := b.pending[key]
	if entry == nil {
		entry = &terminalEventBatch{
			event:    evt,
			bytes:    len(evt.Payload),
			firstSeq: evt.Seq,
			lastSeq:  evt.Seq,
		}
		entry.timer = time.AfterFunc(b.flushEvery, func() {
			b.FlushTerminal(key)
		})
		b.pending[key] = entry
	} else {
		entry.event.Payload += evt.Payload
		entry.event.Seq = evt.Seq
		entry.event.SessionStatus = evt.SessionStatus
		entry.event.TurnStatus = evt.TurnStatus
		entry.event.Timestamp = evt.Timestamp
		entry.bytes += len(evt.Payload)
		if entry.firstSeq == 0 || (evt.Seq > 0 && evt.Seq < entry.firstSeq) {
			entry.firstSeq = evt.Seq
		}
		if evt.Seq > entry.lastSeq {
			entry.lastSeq = evt.Seq
		}
	}
	if entry.bytes >= b.maxBytes {
		toSend = append(toSend, b.takeLocked(key)...)
	}
	b.mu.Unlock()
	for _, evt := range toSend {
		b.emit(evt)
	}
}

func (b *terminalEventBatcher) FlushTerminal(terminalSessionID string) {
	if b == nil || terminalSessionID == "" {
		return
	}
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return
	}
	toSend := b.takeLocked(terminalSessionID)
	b.mu.Unlock()
	for _, evt := range toSend {
		b.emit(evt)
	}
}

func (b *terminalEventBatcher) DropTerminal(terminalSessionID string) {
	if b == nil || terminalSessionID == "" {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	// Seal pending output into the daemon-local ring without waking the cloud
	// stream. If a terminal panel opens later, SnapshotUndeliveredTerminal can
	// replay only the bytes that were never forwarded.
	_ = b.takeLocked(terminalSessionID)
}

func (b *terminalEventBatcher) SnapshotTerminal(terminalSessionID string) (TerminalEvent, bool) {
	return b.snapshotTerminal(terminalSessionID, false)
}

func (b *terminalEventBatcher) SnapshotUndeliveredTerminal(terminalSessionID string) (TerminalEvent, bool) {
	return b.snapshotTerminal(terminalSessionID, true)
}

func (b *terminalEventBatcher) MarkDelivered(evt TerminalEvent) {
	if b == nil || evt.TerminalSessionID == "" || evt.Kind != "text_delta" {
		return
	}
	lastSeq := evt.SeqEnd
	if lastSeq == 0 {
		lastSeq = evt.Seq
	}
	if lastSeq == 0 {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if lastSeq > b.deliveredSeq[evt.TerminalSessionID] {
		b.deliveredSeq[evt.TerminalSessionID] = lastSeq
	}
}

func (b *terminalEventBatcher) snapshotTerminal(terminalSessionID string, undeliveredOnly bool) (TerminalEvent, bool) {
	if b == nil || terminalSessionID == "" {
		return TerminalEvent{}, false
	}
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return TerminalEvent{}, false
	}
	// Seal any pending bytes into the local ring first. The caller controls
	// whether the returned snapshot is sent to the cloud.
	_ = b.takeLocked(terminalSessionID)
	ring := append([]terminalRingEntry(nil), b.rings[terminalSessionID]...)
	deliveredSeq := b.deliveredSeq[terminalSessionID]
	truncated := b.ringTruncated[terminalSessionID]
	b.mu.Unlock()
	if len(ring) == 0 {
		return TerminalEvent{}, false
	}
	payload := strings.Builder{}
	bytes := 0
	var firstSeq, lastSeq int64
	var timestamp time.Time
	for _, entry := range ring {
		if undeliveredOnly && entry.seqEnd > 0 && entry.seqEnd <= deliveredSeq {
			continue
		}
		payload.WriteString(entry.payload)
		bytes += entry.bytes
		if firstSeq == 0 || (entry.seqStart > 0 && entry.seqStart < firstSeq) {
			firstSeq = entry.seqStart
		}
		if entry.seqEnd > lastSeq {
			lastSeq = entry.seqEnd
		}
		if entry.at.After(timestamp) {
			timestamp = entry.at
		}
	}
	evt := TerminalEvent{
		TerminalSessionID: terminalSessionID,
		Kind:              "text_delta",
		Payload:           payload.String(),
		SeqStart:          firstSeq,
		SeqEnd:            lastSeq,
		Timestamp:         timestamp,
		Truncated:         truncated,
	}
	if evt.Timestamp.IsZero() {
		evt.Timestamp = time.Now().UTC()
	}
	_ = bytes // kept for ring accounting parity and future telemetry.
	return evt, evt.Payload != ""
}

func (b *terminalEventBatcher) Close() {
	if b == nil {
		return
	}
	b.mu.Lock()
	if b.closed {
		b.mu.Unlock()
		return
	}
	b.closed = true
	keys := make([]string, 0, len(b.pending))
	for key := range b.pending {
		keys = append(keys, key)
	}
	var toSend []TerminalEvent
	for _, key := range keys {
		toSend = append(toSend, b.takeLocked(key)...)
	}
	b.mu.Unlock()
	for _, evt := range toSend {
		b.emit(evt)
	}
}

func (b *terminalEventBatcher) takeLocked(key string) []TerminalEvent {
	entry := b.pending[key]
	if entry == nil {
		return nil
	}
	delete(b.pending, key)
	if entry.timer != nil {
		entry.timer.Stop()
	}
	evt := entry.event
	if entry.firstSeq > 0 {
		evt.SeqStart = entry.firstSeq
	}
	if entry.lastSeq > 0 {
		evt.SeqEnd = entry.lastSeq
	}
	evt.Truncated = b.recordRingLocked(key, evt, entry.bytes, evt.Timestamp)
	return []TerminalEvent{evt}
}

func (b *terminalEventBatcher) recordRingLocked(key string, evt TerminalEvent, bytes int, at time.Time) bool {
	if at.IsZero() {
		at = time.Now().UTC()
	}
	ring := append(b.rings[key], terminalRingEntry{
		at:       at,
		bytes:    bytes,
		payload:  evt.Payload,
		seqStart: evt.SeqStart,
		seqEnd:   evt.SeqEnd,
	})
	cutoff := at.Add(-b.ringMaxAge)
	total := 0
	start := 0
	truncated := false
	for i := len(ring) - 1; i >= 0; i-- {
		if ring[i].at.Before(cutoff) {
			start = i + 1
			truncated = true
			break
		}
		total += ring[i].bytes
		if total > b.ringMaxBytes {
			start = i + 1
			truncated = true
			break
		}
	}
	if start > 0 {
		ring = append([]terminalRingEntry(nil), ring[start:]...)
	}
	b.rings[key] = ring
	if truncated {
		b.ringTruncated[key] = true
	}
	return truncated
}

func (b *terminalEventBatcher) emit(evt TerminalEvent) {
	if b == nil || b.send == nil {
		return
	}
	b.mu.Lock()
	shouldSend := b.shouldSend
	b.mu.Unlock()
	if shouldSend != nil && !shouldSend(evt) {
		return
	}
	b.send(evt)
	b.MarkDelivered(evt)
}
