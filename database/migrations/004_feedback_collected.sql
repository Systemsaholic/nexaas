-- Add collected column to skill_feedback for SSH sweep tracking
ALTER TABLE skill_feedback ADD COLUMN IF NOT EXISTS collected BOOLEAN DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_skill_feedback_collected ON skill_feedback(collected) WHERE collected = false;
