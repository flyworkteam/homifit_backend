-- ─────────────────────────────────────────────────────────────────────────
-- 003 exercise + workout catalog
-- Master list of exercises (slug-keyed, mirrors video-manifest.json from
-- BunnyCDN) and the predefined workout templates the app shows in
-- Quick Workouts / Popular Plans / Trending screens.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS exercises (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug              VARCHAR(120) NOT NULL,             -- e.g. "bodyweight-squat"
  name_en           VARCHAR(160) NOT NULL,
  name_tr           VARCHAR(160) DEFAULT NULL,
  primary_muscle    VARCHAR(64)  DEFAULT NULL,         -- "chest" / "core" / "legs" / ...
  secondary_muscles JSON DEFAULT NULL,                  -- ["triceps","shoulders"]
  unit              ENUM('reps','seconds') NOT NULL DEFAULT 'reps',
  default_value     SMALLINT UNSIGNED DEFAULT NULL,    -- e.g. 12 reps or 30s
  default_sets      TINYINT  UNSIGNED DEFAULT 3,
  difficulty        ENUM('beginner','intermediate','advanced') DEFAULT 'beginner',
  needs_equipment   TINYINT(1) NOT NULL DEFAULT 0,
  -- Pull URL for BunnyCDN video; can be NULL if no video uploaded yet
  video_cdn_path    VARCHAR(255) DEFAULT NULL,         -- e.g. "egzersizler/bacak/bodyweight-squat.mp4"
  video_url         VARCHAR(512) DEFAULT NULL,         -- absolute https URL (cached)
  thumbnail_path    VARCHAR(255) DEFAULT NULL,         -- preview poster (also on BunnyCDN)
  description       TEXT DEFAULT NULL,
  tip               VARCHAR(255) DEFAULT NULL,
  active            TINYINT(1) NOT NULL DEFAULT 1,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_exercises_slug (slug),
  KEY idx_exercises_muscle (primary_muscle),
  KEY idx_exercises_active (active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Pre-built workout templates (Quick Plan tab + Popular Workouts list).
CREATE TABLE IF NOT EXISTS workout_templates (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug         VARCHAR(120) NOT NULL,
  category     VARCHAR(64)  DEFAULT NULL,             -- "core_abs" / "hiit_cardio" / ...
  title_en     VARCHAR(160) NOT NULL,
  title_tr     VARCHAR(160) DEFAULT NULL,
  level        ENUM('beginner','intermediate','advanced','all') NOT NULL DEFAULT 'all',
  duration_min SMALLINT UNSIGNED NOT NULL DEFAULT 20,
  thumbnail_path VARCHAR(255) DEFAULT NULL,
  is_premium   TINYINT(1) NOT NULL DEFAULT 0,
  active       TINYINT(1) NOT NULL DEFAULT 1,
  sort_order   INT NOT NULL DEFAULT 0,
  created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_workout_templates_slug (slug),
  KEY idx_workout_templates_category (category, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Exercises within a workout template (ordered).
CREATE TABLE IF NOT EXISTS workout_template_exercises (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  template_id   BIGINT UNSIGNED NOT NULL,
  exercise_id   BIGINT UNSIGNED NOT NULL,
  position      SMALLINT UNSIGNED NOT NULL,
  sets          TINYINT  UNSIGNED NOT NULL DEFAULT 3,
  reps          SMALLINT UNSIGNED DEFAULT NULL,
  hold_seconds  SMALLINT UNSIGNED DEFAULT NULL,
  rest_seconds  SMALLINT UNSIGNED NOT NULL DEFAULT 30,
  PRIMARY KEY (id),
  UNIQUE KEY uk_template_position (template_id, position),
  KEY idx_template_exercise (template_id),
  CONSTRAINT fk_wte_template FOREIGN KEY (template_id)
    REFERENCES workout_templates(id) ON DELETE CASCADE,
  CONSTRAINT fk_wte_exercise FOREIGN KEY (exercise_id)
    REFERENCES exercises(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
