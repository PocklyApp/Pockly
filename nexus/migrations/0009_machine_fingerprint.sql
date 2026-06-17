-- Store an app-scoped, non-reversible daemon machine fingerprint so a
-- reinstalled daemon can supersede its old device row for the same account.

ALTER TABLE computers ADD COLUMN machine_fingerprint TEXT;
ALTER TABLE devices ADD COLUMN machine_fingerprint TEXT;
ALTER TABLE daemon_device_authorizations ADD COLUMN machine_fingerprint TEXT;
ALTER TABLE daemon_setup_grants ADD COLUMN machine_fingerprint TEXT;
ALTER TABLE pairing_grants ADD COLUMN machine_fingerprint TEXT;

CREATE INDEX IF NOT EXISTS idx_devices_user_machine_fingerprint
  ON devices(user_id, machine_fingerprint);
