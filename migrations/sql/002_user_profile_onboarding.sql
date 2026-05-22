-- ─────────────────────────────────────────────────────────────────────────
-- 002 user profile + onboarding answers
-- One row per user; profile fields are reused across AI Builder, Manual Plan
-- and Profile screens.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_profile (
  user_id           BIGINT UNSIGNED NOT NULL,
  identity          ENUM('woman','man','non_binary','prefer_not') DEFAULT NULL,
  body_type         ENUM('average','lean','athletic','heavy')     DEFAULT NULL,
  height_cm         SMALLINT UNSIGNED DEFAULT NULL,
  weight_kg         SMALLINT UNSIGNED DEFAULT NULL,
  birth_year        SMALLINT UNSIGNED DEFAULT NULL,
  -- Onboarding choices (also editable later from Profile)
  primary_goal      ENUM('lose_weight','build_muscle','stay_fit','boost_energy') DEFAULT NULL,
  level             ENUM('beginner','intermediate','advanced') DEFAULT NULL,
  duration_min      SMALLINT UNSIGNED DEFAULT NULL,  -- preferred minutes per session
  days_per_week     TINYINT  UNSIGNED DEFAULT NULL,  -- 1..7
  -- AI builder toggles
  warmup_enabled    TINYINT(1) NOT NULL DEFAULT 0,
  stretching_enabled TINYINT(1) NOT NULL DEFAULT 1,
  equipment_enabled TINYINT(1) NOT NULL DEFAULT 0,
  -- JSON list of FocusArea enum values: ["arms","shoulders",...]
  focus_areas       JSON DEFAULT NULL,
  onboarding_completed_at DATETIME DEFAULT NULL,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_profile_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Free-form onboarding answers history (audit trail). Each row is one
-- question/answer pair, so we can replay or change the wizard later
-- without losing data.
CREATE TABLE IF NOT EXISTS user_onboarding_answers (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id     BIGINT UNSIGNED NOT NULL,
  question_key VARCHAR(64)    NOT NULL,
  answer      JSON NOT NULL,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_answers_user_question (user_id, question_key),
  CONSTRAINT fk_answers_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
