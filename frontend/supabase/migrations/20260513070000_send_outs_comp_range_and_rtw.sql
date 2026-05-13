-- Per-send-out comp ranges + right-to-work, captured at submit time so
-- the historical record of what was sent to the client stays correct
-- even if the candidate's profile target_comp values change later.
ALTER TABLE send_outs
  ADD COLUMN IF NOT EXISTS base_comp_min numeric,
  ADD COLUMN IF NOT EXISTS base_comp_max numeric,
  ADD COLUMN IF NOT EXISTS bonus_comp_min numeric,
  ADD COLUMN IF NOT EXISTS bonus_comp_max numeric,
  ADD COLUMN IF NOT EXISTS right_to_work text;

COMMENT ON COLUMN send_outs.base_comp_min IS 'Base comp range low, USD, recorded at submission time';
COMMENT ON COLUMN send_outs.base_comp_max IS 'Base comp range high, USD, recorded at submission time';
COMMENT ON COLUMN send_outs.bonus_comp_min IS 'Bonus comp range low, USD, recorded at submission time';
COMMENT ON COLUMN send_outs.bonus_comp_max IS 'Bonus comp range high, USD, recorded at submission time';
COMMENT ON COLUMN send_outs.right_to_work IS 'Right-to-work / work-authorization status sent to client (free text)';
