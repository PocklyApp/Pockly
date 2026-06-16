-- Keep hot-window turn stats on the session row so common reads do not need to
-- scan session_turns just to compute count/min/max/contiguous metadata.
ALTER TABLE sessions ADD COLUMN actual_turn_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN latest_contiguous_min_seq INTEGER NOT NULL DEFAULT 0;
