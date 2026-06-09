'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { validatePlanInput } = require('../src/controllers/planController');

// These exercise the in-memory de-dup that runs before any DB write, so they
// need no database. The DB-level UNIQUE(day_id, exercise_id) constraint +
// ON DUPLICATE KEY UPDATE upsert are the second line of defense and are covered
// by the live reproduction in scripts/repro_plan_dedup.js.

function manualPlanWith(exercises) {
  return {
    source: 'manual',
    title: 'Test Plan',
    days: [{ weekday: 0, title: 'Day 1', exercises }],
  };
}

test('a day with the same slug repeated collapses to one exercise', () => {
  const clean = validatePlanInput(manualPlanWith([
    { slug: 'bodyweight-squat', name: 'Squat', sets: 3, reps: 12, restSeconds: 30 },
    { slug: 'push-up', name: 'Push Up', sets: 3, reps: 10, restSeconds: 30 },
    { slug: 'bodyweight-squat', name: 'Squat again', sets: 4, reps: 15, restSeconds: 45 },
    { slug: 'push-up', name: 'Push Up again', sets: 2, reps: 8, restSeconds: 20 },
  ]));

  const slugs = clean.days[0].exercises.map((e) => e.slug);
  assert.deepEqual(slugs, ['bodyweight-squat', 'push-up'], 'duplicates dropped, first wins');
});

test('first occurrence wins (keeps the first set/reps, not the later one)', () => {
  const clean = validatePlanInput(manualPlanWith([
    { slug: 'plank', sets: 3, holdSeconds: 30, restSeconds: 30 },
    { slug: 'plank', sets: 5, holdSeconds: 60, restSeconds: 60 },
  ]));

  assert.equal(clean.days[0].exercises.length, 1);
  assert.equal(clean.days[0].exercises[0].sets, 3, 'kept the first occurrence');
  assert.equal(clean.days[0].exercises[0].holdSeconds, 30);
});

test('de-dup is case-insensitive on slug', () => {
  const clean = validatePlanInput(manualPlanWith([
    { slug: 'Push-Up', sets: 3, reps: 10, restSeconds: 30 },
    { slug: 'push-up', sets: 3, reps: 10, restSeconds: 30 },
  ]));
  assert.equal(clean.days[0].exercises.length, 1);
});

test('positions are renumbered contiguously (1..N) after de-dup', () => {
  const clean = validatePlanInput(manualPlanWith([
    { slug: 'a', sets: 3, reps: 10, restSeconds: 30 },
    { slug: 'a', sets: 3, reps: 10, restSeconds: 30 }, // dropped
    { slug: 'b', sets: 3, reps: 10, restSeconds: 30 },
    { slug: 'c', sets: 3, reps: 10, restSeconds: 30 },
  ]));
  assert.deepEqual(clean.days[0].exercises.map((e) => e.position), [1, 2, 3]);
});

test('distinct slugs are all preserved', () => {
  const clean = validatePlanInput(manualPlanWith([
    { slug: 'a', sets: 3, reps: 10, restSeconds: 30 },
    { slug: 'b', sets: 3, reps: 10, restSeconds: 30 },
  ]));
  assert.equal(clean.days[0].exercises.length, 2);
});

test('de-dup is scoped per-day (same slug on two different days is fine)', () => {
  const clean = validatePlanInput({
    source: 'manual',
    title: 'Two Day',
    days: [
      { weekday: 0, exercises: [{ slug: 'squat', sets: 3, reps: 10, restSeconds: 30 }] },
      { weekday: 1, exercises: [{ slug: 'squat', sets: 3, reps: 10, restSeconds: 30 }] },
    ],
  });
  assert.equal(clean.days[0].exercises.length, 1);
  assert.equal(clean.days[1].exercises.length, 1);
});
