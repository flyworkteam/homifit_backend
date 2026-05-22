-- ─────────────────────────────────────────────────────────────────────────
-- 001 init users
-- Base user table. firebase_uid is the immutable identity from Firebase Auth
-- (Google / Apple sign-in); email is informational and may change.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  firebase_uid    VARCHAR(128) NOT NULL,
  email           VARCHAR(320) DEFAULT NULL,
  display_name    VARCHAR(120) DEFAULT NULL,
  photo_url       VARCHAR(512) DEFAULT NULL,
  locale          VARCHAR(8)   NOT NULL DEFAULT 'en',
  timezone        VARCHAR(64)  DEFAULT NULL,
  guest           TINYINT(1)   NOT NULL DEFAULT 0,
  is_active       TINYINT(1)   NOT NULL DEFAULT 1,
  last_login_at   DATETIME     DEFAULT NULL,
  created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_users_firebase_uid (firebase_uid),
  KEY idx_users_email (email),
  KEY idx_users_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A simple session/refresh token store for JWT issuance.
CREATE TABLE IF NOT EXISTS user_refresh_tokens (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         BIGINT UNSIGNED NOT NULL,
  token_hash      CHAR(64)        NOT NULL,
  user_agent      VARCHAR(255)    DEFAULT NULL,
  ip_address      VARCHAR(45)     DEFAULT NULL,
  expires_at      DATETIME        NOT NULL,
  revoked_at      DATETIME        DEFAULT NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_refresh_token_hash (token_hash),
  KEY idx_refresh_user (user_id, expires_at),
  CONSTRAINT fk_refresh_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
