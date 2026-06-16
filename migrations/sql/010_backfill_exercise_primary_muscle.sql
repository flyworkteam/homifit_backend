-- ─────────────────────────────────────────────────────────────────────────
-- 010 backfill exercises.primary_muscle from the CDN muscle folder
--
-- The exercise seed (seedExercisesFromManifest.js) never populated
-- primary_muscle, so it was NULL for every row. The Stats screen
-- (Profile → Your Stats, "Where your work went" / Muscle Focus) groups
-- completed-session sets by primary_muscle, so without this it is always
-- empty.
--
-- Each exercise's canonical muscle is encoded in its video_cdn_path second
-- path segment, e.g. "egzersizler/bacak/bodyweight-squat.mp4" → legs. Only
-- the six canonical muscle folders map to a muscle group; program/utility
-- folders (gerinme=stretching, evde-dambil-egzersizi, bel-agrisindan-kurtulma,
-- kalistenik-plani, kilo-verme-plani, hiit-kardiyo-antrenmani, …) are left
-- NULL and simply do not contribute to the muscle breakdown.
--
-- Muscle keys are stable English slugs the app localizes
-- (Core/Localization). Idempotent: re-running just re-asserts the value.
-- Kept in sync with seedExercisesFromManifest.js (MUSCLE_FOLDER_MAP) so a
-- future re-seed does not revert it.
-- ─────────────────────────────────────────────────────────────────────────

UPDATE exercises SET primary_muscle = 'legs'
  WHERE video_cdn_path LIKE 'egzersizler/bacak/%';

UPDATE exercises SET primary_muscle = 'chest'
  WHERE video_cdn_path LIKE 'egzersizler/gogus/%';

UPDATE exercises SET primary_muscle = 'core'
  WHERE video_cdn_path LIKE 'egzersizler/karin-kaslari/%';

UPDATE exercises SET primary_muscle = 'arms'
  WHERE video_cdn_path LIKE 'egzersizler/kol/%';

UPDATE exercises SET primary_muscle = 'shoulders_back'
  WHERE video_cdn_path LIKE 'egzersizler/omuz-sirt/%';

UPDATE exercises SET primary_muscle = 'full_body'
  WHERE video_cdn_path LIKE 'egzersizler/tum-vucut/%';
