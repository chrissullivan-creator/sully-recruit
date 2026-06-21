-- Phase 2 of the AI-native roadmap: agentic Joe (approval-gated write-tools).
-- The ask-joe edge function reads this flag (service role) and only loads the
-- propose-only write tools when it's on. Default OFF; a missing row is also
-- treated as off, so this seed is just for visibility/control in Settings.
INSERT INTO app_settings (key, value, description)
VALUES ('JOE_AGENTIC_ENABLED', 'false',
        'Phase 2 agentic Joe: load propose-only write tools (draft/enroll/move/task/note) in ask-joe. OFF by default. Requires redeploying the ask-joe edge function after enabling.')
ON CONFLICT (key) DO NOTHING;
