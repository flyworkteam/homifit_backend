-- ─────────────────────────────────────────────────────────────────────────
-- 009 move ab/core workouts into the "Core & Abs" (core_abs) section
--
-- The "Core & Abs" section (category = 'core_abs') only had 2 templates, so it
-- looked empty next to the design (~5 cards). Three ab/core workouts were
-- filed under other categories because the seed derives category from the CDN
-- top folder (populer/gunluk/genel-antremanlar):
--   • baklava-karin-kasi-egzersizi   (was 'popular')  – Six-Pack Abs
--   • karin-ve-core-guclendirme      (was 'daily')    – Core & Abs Strength
--   • core-ve-karin-antrenmani       (was 'general')  – Core & Abs
--
-- They are abdominal/core workouts and belong in Core & Abs, bringing it to 5.
-- workout_templates.category is a single column, so this moves them out of
-- their previous sections (Popular still has 10, Daily 4, General 6 — none of
-- which the design depends on for these specific cards).
--
-- Idempotent: re-running just re-asserts the category. Kept in sync with the
-- CATEGORY_OVERRIDE map in scripts/seedWorkoutTemplatesFromManifest.js so a
-- future re-seed does not revert it.
-- ─────────────────────────────────────────────────────────────────────────

UPDATE workout_templates
   SET category = 'core_abs'
 WHERE slug IN (
   'baklava-karin-kasi-egzersizi',
   'karin-ve-core-guclendirme',
   'core-ve-karin-antrenmani'
 );
