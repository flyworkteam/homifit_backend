#!/usr/bin/env node
/**
 * Mark a hand-picked set of `workout_templates` as Premium.
 *
 * Per `docs/HomiFit – Premium Paket Özellikleri.docx` the free tier is
 * supposed to gate:
 *   • Advanced workouts ("Tüm antrenman seviyelerine erişim")
 *   • Equipment-based / 30-day / advanced plan templates
 *   • Variety / advanced exercise programs
 *
 * Idempotent: runs `UPDATE workout_templates SET is_premium = ? ...` —
 * re-running just re-asserts the same flags.
 *
 *   node scripts/seedPremiumWorkoutTemplates.js
 *
 * Pass `--reset` to clear all `is_premium` flags before reapplying.
 */

require('dotenv').config({ path: require('node:path').resolve(__dirname, '..', '.env') });

const mysql = require('mysql2/promise');

// Slugs that should be Premium-only.
// Editing this list is the canonical way to extend / shrink the gate; do
// not hand-edit DB rows.
const PREMIUM_SLUGS = [
  // Trend Planlar — advanced lifestyle plans
  'kalistenik-plani',
  'kilo-verme-plani',
  'yogun-karin-yagi-yakimi',
  // Equipment-based
  'evde-dambil-egzersizi',
  // High-intensity / advanced strength
  'hiit-kardiyo-antrenmani',
  'evde-guc-antrenmani',
];

async function main() {
  const reset = process.argv.includes('--reset');
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number.parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  try {
    if (reset) {
      const [r] = await conn.execute(
        'UPDATE workout_templates SET is_premium = 0',
      );
      console.log(`Reset: cleared is_premium on ${r.affectedRows} templates.`);
    }

    if (PREMIUM_SLUGS.length === 0) {
      console.log('No slugs to mark — exiting.');
      return;
    }

    const placeholders = PREMIUM_SLUGS.map(() => '?').join(',');
    const [r] = await conn.execute(
      `UPDATE workout_templates
          SET is_premium = 1
        WHERE slug IN (${placeholders})`,
      PREMIUM_SLUGS,
    );
    console.log(
      `Marked ${r.affectedRows} / ${PREMIUM_SLUGS.length} templates as Premium.`,
    );

    // Report which slugs were missing so the operator can fix the list.
    const [rows] = await conn.execute(
      `SELECT slug FROM workout_templates WHERE slug IN (${placeholders})`,
      PREMIUM_SLUGS,
    );
    const found = new Set(rows.map((r) => r.slug));
    const missing = PREMIUM_SLUGS.filter((s) => !found.has(s));
    if (missing.length > 0) {
      console.warn('Slugs NOT in workout_templates (typo?):');
      missing.forEach((s) => console.warn(`  - ${s}`));
    }

    // Final summary so it's obvious what is now gated.
    const [premiumRows] = await conn.execute(
      `SELECT slug, title_en, level FROM workout_templates
        WHERE is_premium = 1 ORDER BY slug`,
    );
    console.log(`\nCurrently Premium (${premiumRows.length} templates):`);
    premiumRows.forEach((r) => {
      console.log(`  ${r.slug.padEnd(36)} ${r.level || '-'}  ${r.title_en || ''}`);
    });
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
