-- Migration 006: OVH integration extensions for deploy_runs
-- Date: 2026-04-04

ALTER TABLE deploy_runs
  ADD COLUMN IF NOT EXISTS ovh_instance_id TEXT,
  ADD COLUMN IF NOT EXISTS public_ip TEXT,
  ADD COLUMN IF NOT EXISTS private_ip TEXT,
  ADD COLUMN IF NOT EXISTS vps_flavor TEXT,
  ADD COLUMN IF NOT EXISTS deploy_mode TEXT DEFAULT 'existing';
