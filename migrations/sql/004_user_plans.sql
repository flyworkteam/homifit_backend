-- ─────────────────────────────────────────────────────────────────────────
-- 004 user plans (AI-generated + manually built)
-- A "plan" is a multi-day program. Days hold an ordered list of exercises.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS user_plans (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id         BIGINT UNSIGNED NOT NULL,
  source          ENUM('ai','manual','template') NOT NULL DEFAULT 'manual',
  title           VARCHAR(160) NOT NULL,
  goal            ENUM('lose_weight','build_muscle','stay_fit','boost_energy') DEFAULT NULL,
  level           ENUM('beginner','intermediate','advanced') DEFAULT NULL,
  duration_min    SMALLINT UNSIGNED NOT NULL DEFAULT 20,    -- per session
  days_per_week   TINYINT  UNSIGNED NOT NULL DEFAULT 3,
  warmup_enabled    TINYINT(1) NOT NULL DEFAULT 0,
  stretching_enabled TINYINT(1) NOT NULL DEFAULT 1,
  equipment_enabled TINYINT(1) NOT NULL DEFAULT 0,
  focus_areas     JSON DEFAULT NULL,                         -- ["arms","core",...]
  template_id     BIGINT UNSIGNED DEFAULT NULL,              -- if cloned from a template
  is_active       TINYINT(1) NOT NULL DEFAULT 1,             -- one "active" plan at a time per user (soft enforced)
  is_archived     TINYINT(1) NOT NULL DEFAULT 0,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_user_plans_user (user_id, is_active, is_archived),
  KEY idx_user_plans_template (template_id),
  CONSTRAINT fk_user_plans_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_user_plans_template FOREIGN KEY (template_id)
    REFERENCES workout_templates(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A plan day = one workout day (Monday, Tuesday, ...). weekday is 0..6
-- (Mon..Sun), matching the manual_plan_state.dart Weekday enum index.
CREATE TABLE IF NOT EXISTS user_plan_days (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  plan_id      BIGINT UNSIGNED NOT NULL,
  weekday      TINYINT UNSIGNED NOT NULL,                   -- 0=Mon ... 6=Sun
  title        VARCHAR(120) DEFAULT NULL,                   -- "Full Body" / "Upper Body" etc.
  PRIMARY KEY (id),
  UNIQUE KEY uk_plan_day (plan_id, weekday),
  CONSTRAINT fk_plan_days_plan FOREIGN KEY (plan_id)
    REFERENCES user_plans(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Exercises within a plan day (ordered).
CREATE TABLE IF NOT EXISTS user_plan_day_exercises (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  day_id        BIGINT UNSIGNED NOT NULL,
  exercise_id   BIGINT UNSIGNED NOT NULL,
  position      SMALLINT UNSIGNED NOT NULL,
  sets          TINYINT  UNSIGNED NOT NULL DEFAULT 3,
  reps          SMALLINT UNSIGNED DEFAULT NULL,
  hold_seconds  SMALLINT UNSIGNED DEFAULT NULL,
  rest_seconds  SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  PRIMARY KEY (id),
  UNIQUE KEY uk_day_position (day_id, position),
  KEY idx_day_ex (day_id),
  CONSTRAINT fk_pde_day FOREIGN KEY (day_id)
    REFERENCES user_plan_days(id) ON DELETE CASCADE,
  CONSTRAINT fk_pde_exercise FOREIGN KEY (exercise_id)
    REFERENCES exercises(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
