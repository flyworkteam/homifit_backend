-- ─────────────────────────────────────────────────────────────────────────
-- 012 one-free-trial-per-device guard
--
-- The 3-day free trial is granted once per USER (premium_status.trial_end).
-- That alone lets someone farm unlimited trials by making new accounts on the
-- same phone. This table records which DEVICE already seeded a trial so a given
-- device can only ever activate the trial for a single account.
--
-- `device_id` is a stable client-generated identifier (iOS identifierForVendor,
-- otherwise a UUID persisted in the device keychain/secure storage). It is the
-- PRIMARY KEY, so claiming a device for a trial is an atomic INSERT — the first
-- account wins, every later account on that device is rejected.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS premium_trial_devices (
  device_id  VARCHAR(191) NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (device_id),
  KEY idx_trial_device_user (user_id),
  CONSTRAINT fk_trial_device_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
