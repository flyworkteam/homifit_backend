-- ─────────────────────────────────────────────────────────────────────────
-- 011 in-progress workout session resume state
-- Stores the LAST position (exercise + set index) a user reached inside a
-- workout that was started but not yet completed, so re-entering the same
-- workout resumes from where they left off. One live row per (user, scope);
-- scope_key is 'day:<planDayId>' for plan workouts or 'tpl:<templateId>' for
-- quick-workout templates. The row is deleted once the workout is completed.
-- ─────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS workout_session_progress (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id        BIGINT UNSIGNED NOT NULL,
  scope_key      VARCHAR(64) NOT NULL,
  plan_day_id    BIGINT UNSIGNED DEFAULT NULL,
  template_id    BIGINT UNSIGNED DEFAULT NULL,
  exercise_index SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  set_index      SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_wsp_user_scope (user_id, scope_key),
  CONSTRAINT fk_wsp_user FOREIGN KEY (user_id)
    REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_wsp_day FOREIGN KEY (plan_day_id)
    REFERENCES user_plan_days(id) ON DELETE CASCADE,
  CONSTRAINT fk_wsp_template FOREIGN KEY (template_id)
    REFERENCES workout_templates(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
