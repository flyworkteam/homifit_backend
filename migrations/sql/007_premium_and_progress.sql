-- ─────────────────────────────────────────────────────────────────────────
-- 007 premium subscription state + measurement / progress logs
-- premium_status mirrors RevenueCat entitlements per user.
-- progress_log + body_measurements support the Stats / Progress screens.
-- ─────────────────────────────────────────────────────────────────────────

-- One row per user. Updated by the RevenueCat webhook handler.
CREATE TABLE IF NOT EXISTS premium_status (
  user_id              BIGINT UNSIGNED NOT NULL,
  is_premium           TINYINT(1) NOT NULL DEFAULT 0,
  entitlement          VARCHAR(64) DEFAULT NULL,            -- "pro_monthly" / "pro_yearly"
  product_id           VARCHAR(120) DEFAULT NULL,
  store                ENUM('app_store','play_store','stripe','manual') DEFAULT NULL,
  purchase_token       VARCHAR(255) DEFAULT NULL,
  original_app_user_id VARCHAR(120) DEFAULT NULL,
  current_period_start DATETIME DEFAULT NULL,
  current_period_end   DATETIME DEFAULT NULL,
  trial_end            DATETIME DEFAULT NULL,
  cancelled_at         DATETIME DEFAULT NULL,
  refunded_at          DATETIME DEFAULT NULL,
  promo_discount_pct   TINYINT UNSIGNED NOT NULL DEFAULT 0, -- streak reward etc.
  updated_at           DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  KEY idx_premium_active (is_premium, current_period_end),
  CONSTRAINT fk_premium_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- RevenueCat webhook events (audit + idempotency).
CREATE TABLE IF NOT EXISTS premium_events (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id       BIGINT UNSIGNED DEFAULT NULL,                -- NULL if unmatched
  event_id      VARCHAR(120) NOT NULL,                       -- from RC payload
  event_type    VARCHAR(64) NOT NULL,
  app_user_id   VARCHAR(120) DEFAULT NULL,
  payload       JSON NOT NULL,
  processed     TINYINT(1) NOT NULL DEFAULT 0,
  received_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_premium_event_id (event_id),
  KEY idx_premium_events_user (user_id, received_at DESC),
  CONSTRAINT fk_premium_event_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Body measurements over time (Profile → Edit → weight/height history).
CREATE TABLE IF NOT EXISTS body_measurements (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id      BIGINT UNSIGNED NOT NULL,
  measured_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  weight_kg    DECIMAL(5,2) DEFAULT NULL,
  height_cm    SMALLINT UNSIGNED DEFAULT NULL,
  body_fat_pct DECIMAL(4,1) DEFAULT NULL,
  source       ENUM('manual','health_app') NOT NULL DEFAULT 'manual',
  PRIMARY KEY (id),
  KEY idx_meas_user_date (user_id, measured_at DESC),
  CONSTRAINT fk_meas_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Generic progress event log for the Stats screen ("This week" / charts).
CREATE TABLE IF NOT EXISTS progress_log (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  event_type  VARCHAR(48) NOT NULL,                         -- 'workout_completed','set_completed','goal_changed',...
  amount      INT DEFAULT NULL,                             -- e.g. minutes or reps
  meta        JSON DEFAULT NULL,
  occurred_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_progress_user_date (user_id, occurred_at DESC),
  KEY idx_progress_event_type (event_type, occurred_at DESC),
  CONSTRAINT fk_progress_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Apple Health / Health Connect sync state per user.
CREATE TABLE IF NOT EXISTS health_sync_state (
  user_id           BIGINT UNSIGNED NOT NULL,
  apple_health_on   TINYINT(1) NOT NULL DEFAULT 0,
  health_connect_on TINYINT(1) NOT NULL DEFAULT 0,
  last_sync_at      DATETIME DEFAULT NULL,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_health_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
