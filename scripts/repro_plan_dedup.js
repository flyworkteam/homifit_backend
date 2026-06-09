'use strict';

// Live reproduction of the "manual plan stores an exercise 2-3×" fix.
// Invokes the REAL createPlan + getPlan controller handlers (POST /plans then
// GET /plans/:id) against a database.
//
// SAFETY: defaults to the LOCAL docker MariaDB (docker-compose.local.yml).
// It hard-sets the local DB creds below so it never touches the remote .env DB.
// Override via env if your local DB differs.
//
//   node scripts/repro_plan_dedup.js

process.env.DB_HOST = process.env.DB_HOST || '127.0.0.1';
process.env.DB_PORT = process.env.DB_PORT || '3306';
process.env.DB_USER = process.env.DB_USER || 'homifit';
process.env.DB_PASSWORD = process.env.DB_PASSWORD || 'homifit';
process.env.DB_NAME = process.env.DB_NAME || 'flywork1_homifit';

const assert = require('node:assert/strict');
const { pool } = require('../src/config/db');
const planController = require('../src/controllers/planController');

// Minimal Express res double; resolves the await when the handler calls json().
function callController(handler, req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ statusCode: this.statusCode, body: payload }); return this; },
    };
    Promise.resolve(handler(req, res, (err) => (err ? reject(err) : resolve({ next: true }))))
      .catch(reject);
  });
}

(async () => {
  let userId;
  let planId;
  try {
    // 1. Seed a throwaway user (FK target for user_plans.user_id).
    const [u] = await pool.execute(
      `INSERT INTO users (firebase_uid, email, display_name, guest)
       VALUES (?, ?, ?, 1)`,
      [`repro-dedup-${process.pid}`, 'repro@example.test', 'Repro User'],
    );
    userId = u.insertId;

    // 2. POST a manual plan whose Day 1 lists the SAME slug 3× and another 2× —
    //    exactly the buggy client payload that produced 2-3 copies.
    const body = {
      source: 'manual',
      title: 'Repro Manual Plan',
      level: 'beginner',
      days: [{
        weekday: 0,
        title: 'Full Body',
        exercises: [
          { slug: 'repro-squat', name: 'Squat', sets: 3, reps: 12, restSeconds: 30 },
          { slug: 'repro-pushup', name: 'Push Up', sets: 3, reps: 10, restSeconds: 30 },
          { slug: 'repro-squat', name: 'Squat dup', sets: 4, reps: 15, restSeconds: 45 },
          { slug: 'repro-squat', name: 'Squat dup2', sets: 5, reps: 20, restSeconds: 60 },
          { slug: 'repro-pushup', name: 'Push Up dup', sets: 2, reps: 8, restSeconds: 20 },
        ],
      }],
    };
    const createRes = await callController(planController.createPlan, {
      body, userId, params: {}, query: {}, premium: { isPremium: false },
    });
    const created = createRes.body && createRes.body.data && createRes.body.data.plan;
    assert.ok(created, `createPlan did not return a plan: ${JSON.stringify(createRes.body)}`);
    planId = created.id;
    console.log(`POST /plans -> created plan #${planId} (sent 5 exercises, 2 distinct slugs)`);

    // 3. GET it back through the real getPlan handler.
    const getRes = await callController(planController.getPlan, {
      userId, params: { id: planId }, query: {},
    });
    const plan = getRes.body.data.plan;

    // 4. Assert no slug appears more than once on any day.
    let ok = true;
    for (const day of plan.days) {
      const slugs = day.exercises.map((e) => e.slug);
      const counts = slugs.reduce((m, s) => m.set(s, (m.get(s) || 0) + 1), new Map());
      const dups = [...counts.entries()].filter(([, n]) => n > 1);
      console.log(`GET /plans/${planId} -> day ${day.weekday} "${day.title}": [${slugs.join(', ')}]`);
      if (dups.length) {
        ok = false;
        console.log(`    duplicate slugs: ${dups.map(([s, n]) => `${s}x${n}`).join(', ')}`);
      }
    }
    assert.deepEqual(
      plan.days[0].exercises.map((e) => e.slug).sort(),
      ['repro-pushup', 'repro-squat'],
      'day 1 should contain exactly the two distinct slugs',
    );

    // 5. Prove the DB backstop independently: a raw duplicate insert must NOT
    //    create a second row (idempotent upsert / UNIQUE(day_id, exercise_id)).
    const [dayRows] = await pool.execute(
      'SELECT id FROM user_plan_days WHERE plan_id = ? LIMIT 1', [planId],
    );
    const dayId = dayRows[0].id;
    const [exRows] = await pool.execute(
      'SELECT exercise_id FROM user_plan_day_exercises WHERE day_id = ? LIMIT 1', [dayId],
    );
    const exId = exRows[0].exercise_id;
    await pool.execute(
      `INSERT INTO user_plan_day_exercises (day_id, exercise_id, position, sets, reps, rest_seconds)
       VALUES (?, ?, 99, 9, 9, 9)
       ON DUPLICATE KEY UPDATE sets = VALUES(sets)`,
      [dayId, exId],
    );
    const [after] = await pool.execute(
      'SELECT COUNT(*) AS n FROM user_plan_day_exercises WHERE day_id = ? AND exercise_id = ?',
      [dayId, exId],
    );
    assert.equal(after[0].n, 1, 'duplicate (day_id, exercise_id) must not create a 2nd row');
    console.log('Raw duplicate insert into user_plan_day_exercises -> still 1 row (upsert/UNIQUE held)');

    console.log(ok
      ? '\nPASS - no slug repeats on any day; DB rejects duplicate rows.'
      : '\nFAIL - duplicates found.');
    if (!ok) process.exitCode = 1;
  } finally {
    // Cleanup cascades to days + day-exercises. Throwaway `exercises` rows
    // (repro-*) are slug-unique and harmless, so reruns just reuse them.
    if (planId) await pool.execute('DELETE FROM user_plans WHERE id = ?', [planId]);
    if (userId) await pool.execute('DELETE FROM users WHERE id = ?', [userId]);
    await pool.end();
  }
})().catch((err) => {
  console.error('Reproduction failed:', err.message || err);
  process.exitCode = 1;
  pool.end();
});
