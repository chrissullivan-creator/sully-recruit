-- Create candidate_channels table that ~10 keep-list code paths expect.
-- Was the root cause of "so many errors" on Trigger.dev tasks: send-channels,
-- unipile-resolve, check-connections, webhook-unipile, sync-conversations, send-message,
-- and the inbox / compose-message / resume drop UI all reference this table.
--
-- Acts as a cache: per-candidate per-channel (linkedin/email/sms) ID + connection state.
-- If empty, code falls back to live Unipile API lookups, so creating an empty table is safe.
--
-- Also creates contact_channels as a backwards-compat view (mirrors the contacts pattern).

CREATE TABLE IF NOT EXISTS candidate_channels (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id             uuid NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  channel                  text NOT NULL CHECK (channel IN ('linkedin','linkedin_recruiter','linkedin_classic','linkedin_sales_nav','email','sms')),
  account_id               uuid REFERENCES integration_accounts(id) ON DELETE SET NULL,
  unipile_id               text,
  provider_id              text,
  external_conversation_id text,
  is_connected             boolean NOT NULL DEFAULT false,
  connection_status        text,
  last_synced_at           timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (candidate_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_candidate_channels_candidate ON candidate_channels(candidate_id);
CREATE INDEX IF NOT EXISTS idx_candidate_channels_provider  ON candidate_channels(provider_id) WHERE provider_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_candidate_channels_unipile   ON candidate_channels(unipile_id)  WHERE unipile_id  IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_candidate_channels_account   ON candidate_channels(account_id)  WHERE account_id  IS NOT NULL;

ALTER TABLE candidate_channels ENABLE ROW LEVEL SECURITY;
CREATE POLICY "team can read candidate_channels"  ON candidate_channels FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated all candidate_channels write" ON candidate_channels FOR ALL TO authenticated USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION set_candidate_channels_updated_at() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, extensions AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;
CREATE TRIGGER candidate_channels_updated_at
  BEFORE UPDATE ON candidate_channels
  FOR EACH ROW EXECUTE FUNCTION set_candidate_channels_updated_at();

-- Backwards-compat: contact_channels = candidate_channels rows where the candidate is type='client'
CREATE VIEW contact_channels
WITH (security_invoker = true) AS
SELECT
  cc.id,
  cc.candidate_id AS contact_id,
  cc.channel,
  cc.account_id,
  cc.unipile_id,
  cc.provider_id,
  cc.external_conversation_id,
  cc.is_connected,
  cc.connection_status,
  cc.last_synced_at,
  cc.created_at,
  cc.updated_at
FROM candidate_channels cc
JOIN candidates c ON c.id = cc.candidate_id
WHERE c.type = 'client';

COMMENT ON VIEW  contact_channels    IS 'Backwards-compat view over candidate_channels, filtered to client-type candidates. INSTEAD OF triggers redirect writes.';
COMMENT ON TABLE candidate_channels  IS 'Per-candidate per-channel cache: Unipile/provider IDs, connection state. Empty rows = fall back to live Unipile API lookup.';

CREATE OR REPLACE FUNCTION contact_channels_view_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, extensions AS $$
BEGIN
  INSERT INTO candidate_channels (
    id, candidate_id, channel, account_id, unipile_id, provider_id,
    external_conversation_id, is_connected, connection_status, last_synced_at,
    created_at, updated_at
  ) VALUES (
    COALESCE(NEW.id, gen_random_uuid()), NEW.contact_id, NEW.channel, NEW.account_id,
    NEW.unipile_id, NEW.provider_id, NEW.external_conversation_id,
    COALESCE(NEW.is_connected, false), NEW.connection_status, NEW.last_synced_at,
    COALESCE(NEW.created_at, now()), COALESCE(NEW.updated_at, now())
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER contact_channels_view_insert_trg INSTEAD OF INSERT ON contact_channels
  FOR EACH ROW EXECUTE FUNCTION contact_channels_view_insert();

CREATE OR REPLACE FUNCTION contact_channels_view_update() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, extensions AS $$
BEGIN
  UPDATE candidate_channels SET
    candidate_id             = NEW.contact_id,
    channel                  = NEW.channel,
    account_id               = NEW.account_id,
    unipile_id               = NEW.unipile_id,
    provider_id              = NEW.provider_id,
    external_conversation_id = NEW.external_conversation_id,
    is_connected             = NEW.is_connected,
    connection_status        = NEW.connection_status,
    last_synced_at           = NEW.last_synced_at,
    updated_at               = now()
  WHERE id = OLD.id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER contact_channels_view_update_trg INSTEAD OF UPDATE ON contact_channels
  FOR EACH ROW EXECUTE FUNCTION contact_channels_view_update();

CREATE OR REPLACE FUNCTION contact_channels_view_delete() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, extensions AS $$
BEGIN
  DELETE FROM candidate_channels WHERE id = OLD.id;
  RETURN OLD;
END;
$$;
CREATE TRIGGER contact_channels_view_delete_trg INSTEAD OF DELETE ON contact_channels
  FOR EACH ROW EXECUTE FUNCTION contact_channels_view_delete();
