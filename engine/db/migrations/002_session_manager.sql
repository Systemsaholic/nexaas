-- Migration 002: Add Claude Code session tracking to chat_sessions

ALTER TABLE chat_sessions ADD COLUMN claude_session_id TEXT;
ALTER TABLE chat_sessions ADD COLUMN session_type TEXT DEFAULT 'claude_code';
