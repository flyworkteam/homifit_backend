#!/usr/bin/env node
/**
 * Populates `exercises.name_tr` with Turkish display names by mapping each
 * known slug. Idempotent — safely re-runnable; only updates rows where
 * name_tr is NULL or empty.
 */

require('dotenv').config({ path: require('node:path').resolve(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');

const NAMES = {
  // Karın / Core
  'plank': 'Plank',
  'crunch': 'Mekik',
  'reverse-crunch': 'Ters Mekik',
  'bicycle-crunch': 'Bisiklet Mekiği',
  'flutter-kick': 'Çırpan Bacak',
  'leg-raise': 'Bacak Kaldırma',
  'heel-touch': 'Topuk Dokunuşu',
  'toe-touch-crunch': 'Parmak Ucu Mekiği',
  'russian-twist': 'Rus Twisti',
  'mountain-climber': 'Dağcı (Mountain Climber)',

  // Bacak / Legs
  'bodyweight-squat': 'Vücut Ağırlıklı Squat',
  'jump-squat': 'Sıçramalı Squat',
  'sumo-squat': 'Sumo Squat',
  'wall-sit': 'Duvar Squat',
  'forward-lunge': 'Öne Hamle',
  'reverse-lunge': 'Geri Hamle',
  'side-lunge': 'Yana Hamle',
  'bulgarian-split-squat-sandalye': 'Bulgar Split Squat (sandalye)',
  'bulgarian-split-squat': 'Bulgar Split Squat',
  'glute-bridge': 'Kalça Köprüsü',
  'glute-bridge-march': 'Kalça Köprüsü Yürüyüş',
  'calf-raise': 'Topuk Yükseltme',

  // Göğüs / Chest
  'push-up': 'Şınav',
  'wide-push-up': 'Geniş Şınav',
  'incline-push-up': 'Eğimli Şınav',
  'decline-bench-press': 'Bench Press (eğimli)',
  'diamond-push': 'Elmas Şınav',
  'diamond-push-up': 'Elmas Şınav',
  'knee-push-up': 'Diz Üstü Şınav',
  'slow-push-up': 'Yavaş Şınav',
  'plank-push-up': 'Plank Şınav',
  'archer-push-up': 'Okçu Şınav',
  'explosive-push-up': 'Patlayıcı Şınav',

  // Kol / Arm
  'triceps-dip': 'Triceps Dip',
  'triceps-extension': 'Triceps Açma',
  'pike-push-up': 'Pike Şınav',
  'plank-shoulder-tap': 'Plank Omuz Dokunuşu',
  'plank-up-down': 'Plank Yukarı-Aşağı',
  'wall-push-up': 'Duvar Şınavı',
  'dips-bench-or-paralel-bar': 'Dips (Bench / Paralel Bar)',

  // Tüm vücut + Cardio
  'jumping-jack': 'Jumping Jack',
  'high-knees': 'Yüksek Diz',
  'high-knees-light': 'Yüksek Diz (Hafif)',
  'butt-kicks': 'Topuk Vurma',
  'burpee': 'Burpee',
  'fast-feet-shuffle': 'Hızlı Ayak Shuffle',
  'skater-jump': 'Patenci Sıçraması',
  'plank-jack': 'Plank Jack',
  'plank-walkout': 'Plank Yürüyüş',
  'inchworm': 'Solucan Yürüyüşü',
  'arm-circles': 'Kol Çevirme',

  // Isınma
  'bodyweight-squat-slow': 'Vücut Ağırlıklı Squat (Yavaş)',
  'jumping-jack-slow-tempo': 'Jumping Jack (Yavaş Tempo)',
  'arm-circles-warmup': 'Kol Çevirme (Isınma)',
  'hip-circles': 'Kalça Çevirme',
  'leg-swings': 'Bacak Sallaması',
  'neck-rotation': 'Boyun Rotasyonu',
  'torso-twist': 'Gövde Twisti',
  'pelvic-tilt': 'Pelvik Eğim',

  // Esneme / Stretch
  'cat-cow': 'Kedi-İnek',
  'cat-cow-stretch': 'Kedi-İnek Esneme',
  'child-s-pose': 'Çocuk Pozu',
  'child-pose': 'Çocuk Pozu',
  'cobra-strecch': 'Kobra Esnemesi',
  'cobra-stretch': 'Kobra Esnemesi',
  'hamstring-stretch': 'Hamstring Esnemesi',
  'neck-stretch': 'Boyun Esnemesi',
  'quad-stretch': 'Quad Esnemesi',
  'shoulder-stretch': 'Omuz Esnemesi',
  'standing-forward-bend': 'Ayakta Öne Eğilme',
  'triceps-stretch': 'Triceps Esnemesi',
  'hip-flexor-stretch': 'Kalça Fleksör Esnemesi',
  'knee-to-chest-stretch': 'Diz-Göğüs Esnemesi',
  'spinal-twist': 'Omurga Twisti',

  // Ek Bacak
  'lunges': 'Hamleler',
  'squat': 'Squat',
  'squat-knee-raise': 'Squat + Diz Kaldırma',
  'squat-to-press': 'Squat to Press',
  'lunge-twist': 'Hamle + Twist',

  // Sırt
  'pull-up': 'Barfiks (Pull-up)',
  'back-extension': 'Sırt Açma',
  'superman-back-extension': 'Superman',
  'reverse-snow-angel': 'Ters Kar Meleği',
  'reverse-plank': 'Ters Plank',
  'bird-dog': 'Kuş-Köpek',

  // Omuz / Üst gövde ek
  't-raise-floor': 'T Kaldırma (yerde)',
  'y-raise': 'Y Kaldırma',
  'wall-walk': 'Duvar Yürüyüşü',
  'bear-crawl-hold': 'Ayı Yürüyüşü Tutuş',
  'close-grip-push-up': 'Yakın Tutuş Şınav',

  // Dumbbell hareketleri
  'dumbbell-bent-over-row': 'Dumbbell Eğik Kürek',
  'dumbbell-biceps-curl': 'Dumbbell Biceps Curl',
  'dumbbell-chest-press': 'Dumbbell Göğüs Press',
  'dumbbell-goblet-squat': 'Dumbbell Goblet Squat',
  'dumbbell-lateral-raise': 'Dumbbell Yana Kaldırma',
  'dumbbell-lunges': 'Dumbbell Hamle',
  'dumbbell-romanian-deadlift': 'Dumbbell Romen Deadlift',
  'dumbbell-shoulder-press': 'Dumbbell Omuz Press',
  'dumbbell-squat': 'Dumbbell Squat',
  'dumbbell-triceps-overhead-extension': 'Dumbbell Triceps Açma',
};

async function main() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number.parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });

  let updated = 0;
  let skipped = 0;
  let unknown = 0;

  try {
    const [rows] = await conn.execute('SELECT id, slug, name_en, name_tr FROM exercises');
    for (const row of rows) {
      const tr = NAMES[row.slug];
      if (!tr) {
        unknown += 1;
        console.warn(`!! no Turkish for slug=${row.slug} (en="${row.name_en}")`);
        continue;
      }
      if (row.name_tr && row.name_tr.trim().length > 0) {
        skipped += 1;
        continue;
      }
      await conn.execute('UPDATE exercises SET name_tr = ? WHERE id = ?', [tr, row.id]);
      updated += 1;
    }
    console.log(`updated=${updated} skipped(already-set)=${skipped} unknown=${unknown} total=${rows.length}`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
