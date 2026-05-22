-- ─────────────────────────────────────────────────────────────────────────
-- 006 notifications + device tokens
-- Push prefs, OneSignal player IDs, and a rotation log so we can satisfy
-- the docx requirement: "6 saatte bir, aynı metin art arda kullanılmaz".
-- ─────────────────────────────────────────────────────────────────────────

-- One row per user.
CREATE TABLE IF NOT EXISTS user_notification_prefs (
  user_id            BIGINT UNSIGNED NOT NULL,
  enabled            TINYINT(1) NOT NULL DEFAULT 1,
  locale             VARCHAR(8)  NOT NULL DEFAULT 'tr',
  frequency_hours    TINYINT UNSIGNED NOT NULL DEFAULT 6,
  quiet_hours_start  TIME DEFAULT NULL,                 -- e.g. 23:00
  quiet_hours_end    TIME DEFAULT NULL,                 -- e.g. 08:00
  workout_reminders  TINYINT(1) NOT NULL DEFAULT 1,
  streak_reminders   TINYINT(1) NOT NULL DEFAULT 1,
  promo_messages     TINYINT(1) NOT NULL DEFAULT 1,
  updated_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_notif_prefs_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- OneSignal device subscriptions. A user may have N devices.
CREATE TABLE IF NOT EXISTS device_tokens (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         BIGINT UNSIGNED NOT NULL,
  player_id       VARCHAR(64) NOT NULL,                  -- OneSignal player id
  platform        ENUM('ios','android','web') NOT NULL,
  app_version     VARCHAR(32) DEFAULT NULL,
  device_model    VARCHAR(80) DEFAULT NULL,
  locale          VARCHAR(8)  DEFAULT NULL,
  is_active       TINYINT(1)  NOT NULL DEFAULT 1,
  last_seen_at    DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at      DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_device_player (player_id),
  KEY idx_device_user (user_id, is_active),
  CONSTRAINT fk_device_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Rotation tracking: lastSentMessageId + timestamp per user.
-- The scheduler reads this row to enforce 6h cooldown + skip lastId.
CREATE TABLE IF NOT EXISTS user_notification_state (
  user_id          BIGINT UNSIGNED NOT NULL,
  last_message_id  VARCHAR(64) DEFAULT NULL,
  last_sent_at     DATETIME    DEFAULT NULL,
  next_eligible_at DATETIME    DEFAULT NULL,
  consecutive_sends INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_notif_state_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Audit log of every notification fanned out (analytics + dedupe).
CREATE TABLE IF NOT EXISTS notification_log (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id       BIGINT UNSIGNED NOT NULL,
  message_id    VARCHAR(64) NOT NULL,
  title         VARCHAR(160) NOT NULL,
  body          VARCHAR(500) NOT NULL,
  locale        VARCHAR(8) NOT NULL DEFAULT 'tr',
  channel       ENUM('push','inapp','email') NOT NULL DEFAULT 'push',
  provider      ENUM('onesignal','manual','test') NOT NULL DEFAULT 'onesignal',
  provider_response_id VARCHAR(80) DEFAULT NULL,
  delivered_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_notif_log_user_date (user_id, delivered_at DESC),
  KEY idx_notif_log_message (message_id),
  CONSTRAINT fk_notif_log_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- In-app notification inbox (Today / Earlier list in ProfileNotificationsView).
CREATE TABLE IF NOT EXISTS user_inbox (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id      BIGINT UNSIGNED NOT NULL,
  kind         ENUM('reminder','streak','promo','system') NOT NULL DEFAULT 'reminder',
  title        VARCHAR(160) NOT NULL,
  body         VARCHAR(500) NOT NULL,
  cta_label    VARCHAR(64) DEFAULT NULL,
  cta_route    VARCHAR(64) DEFAULT NULL,                 -- Flutter named route
  read_at      DATETIME DEFAULT NULL,
  archived_at  DATETIME DEFAULT NULL,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_inbox_user (user_id, created_at DESC),
  CONSTRAINT fk_inbox_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
