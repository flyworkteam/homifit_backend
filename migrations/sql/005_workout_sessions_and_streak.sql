-- ─────────────────────────────────────────────────────────────────────────
-- 005 workout sessions + streak log
-- A "session" = one completed workout (plan day OR ad-hoc quick workout).
-- streak_log keeps a per-day flag so we can compute the streak counter
-- and the weekly-progress dot row in StreakDetailSheet.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workout_sessions (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         BIGINT UNSIGNED NOT NULL,
  plan_id         BIGINT UNSIGNED DEFAULT NULL,
  plan_day_id     BIGINT UNSIGNED DEFAULT NULL,
  template_id     BIGINT UNSIGNED DEFAULT NULL,        -- if quick workout
  source          ENUM('plan','quick','custom') NOT NULL DEFAULT 'plan',
  started_at      DATETIME NOT NULL,
  completed_at    DATETIME DEFAULT NULL,
  duration_sec    INT UNSIGNED DEFAULT NULL,
  exercises_done  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  exercises_total SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  calories_kcal   SMALLINT UNSIGNED DEFAULT NULL,
  PRIMARY KEY (id),
  KEY idx_session_user_started (user_id, started_at),
  KEY idx_session_plan (plan_id),
  KEY idx_session_template (template_id),
  CONSTRAINT fk_session_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_session_plan FOREIGN KEY (plan_id)
    REFERENCES user_plans(id) ON DELETE SET NULL,
  CONSTRAINT fk_session_day FOREIGN KEY (plan_day_id)
    REFERENCES user_plan_days(id) ON DELETE SET NULL,
  CONSTRAINT fk_session_template FOREIGN KEY (template_id)
    REFERENCES workout_templates(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per (user, day) when at least one workout was completed.
-- Computing the streak = scan back from today and count consecutive entries.
CREATE TABLE IF NOT EXISTS streak_log (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id       BIGINT UNSIGNED NOT NULL,
  log_date      DATE NOT NULL,
  workouts_done SMALLINT UNSIGNED NOT NULL DEFAULT 1,
  minutes_done  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_streak_user_day (user_id, log_date),
  KEY idx_streak_user_date (user_id, log_date DESC),
  CONSTRAINT fk_streak_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Cached counters (denormalized for fast Home banner / streak badge).
-- Updated by an after-insert trigger or via the StreakService.
CREATE TABLE IF NOT EXISTS user_streak_counters (
  user_id           BIGINT UNSIGNED NOT NULL,
  current_streak    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  longest_streak    SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  total_workouts    INT UNSIGNED NOT NULL DEFAULT 0,
  total_minutes     INT UNSIGNED NOT NULL DEFAULT 0,
  weekly_done       TINYINT UNSIGNED NOT NULL DEFAULT 0,
  weekly_goal       TINYINT UNSIGNED NOT NULL DEFAULT 5,
  extended_unlocked TINYINT(1) NOT NULL DEFAULT 0,
  reward_claimed    TINYINT(1) NOT NULL DEFAULT 0,
  discount_active   TINYINT(1) NOT NULL DEFAULT 0,
  discount_percent  TINYINT UNSIGNED NOT NULL DEFAULT 0,
  last_workout_at   DATETIME DEFAULT NULL,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_streak_counters_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
