-- ─────────────────────────────────────────────────────────────────────────
-- 008 de-duplicate plan-day exercises + enforce one row per (day, exercise)
--
-- Saved MANUAL plans were rendering some exercises 2-3× because the create-plan
-- handler inserted days[].exercises[] in a loop with no de-dup, and the only
-- uniqueness on user_plan_day_exercises was UNIQUE(day_id, position) — distinct
-- positions happily let the SAME exercise_id repeat within a day. (The read-path
-- JOINs are on exercises.id, a primary key, so they're already 1:1 — the dupes
-- were stored, not fanned out at read.)
--
-- Fix, in two steps:
--   1. Collapse pre-existing duplicates, keeping the earliest row (lowest id)
--      per (day_id, exercise_id).
--   2. Add UNIQUE(day_id, exercise_id) so a collision can never store a dup
--      again. The handler now upserts via INSERT ... ON DUPLICATE KEY UPDATE.
-- ─────────────────────────────────────────────────────────────────────────

-- 1. Drop duplicate rows: delete any row that has a lower-id sibling sharing
--    the same (day_id, exercise_id). Remaining positions may have gaps — that's
--    harmless since reads ORDER BY position.
DELETE pde
  FROM user_plan_day_exercises pde
  JOIN user_plan_day_exercises keep
    ON keep.day_id = pde.day_id
   AND keep.exercise_id = pde.exercise_id
   AND keep.id < pde.id;

-- 2. Enforce one row per (day, exercise) going forward.
--    ALGORITHM=INPLACE, LOCK=NONE builds the index online so concurrent plan
--    saves are not blocked while it runs on a populated prod table. (If a stray
--    duplicate survives step 1 the ADD UNIQUE still hard-fails — that's by
--    design: better to abort the migration than silently keep duplicates.)
ALTER TABLE user_plan_day_exercises
  ADD UNIQUE KEY uk_day_exercise (day_id, exercise_id),
  ALGORITHM=INPLACE, LOCK=NONE;
