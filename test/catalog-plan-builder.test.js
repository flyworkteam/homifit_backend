'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  spreadDays,
  buildCatalogPlanDays,
  enrichAiDays,
} = require('../src/services/catalogPlanBuilder');

const sampleCatalog = [
  {
    slug: 'jumping-jack',
    name: 'Jumping Jacks',
    primaryMuscle: 'full_body',
    unit: 'seconds',
    defaultSets: 3,
    defaultValue: 30,
    thumbnailUrl: 'https://cdn.example/jj.jpg',
    videoUrl: 'https://cdn.example/jj.mp4',
  },
  {
    slug: 'bodyweight-squat',
    name: 'Bodyweight Squats',
    primaryMuscle: 'legs',
    unit: 'reps',
    defaultSets: 3,
    defaultValue: 12,
    thumbnailUrl: 'https://cdn.example/sq.jpg',
    videoUrl: 'https://cdn.example/sq.mp4',
  },
  {
    slug: 'plank-hold',
    name: 'Plank Hold',
    primaryMuscle: 'core',
    unit: 'seconds',
    defaultSets: 3,
    defaultValue: 30,
    thumbnailUrl: 'https://cdn.example/pl.jpg',
    videoUrl: 'https://cdn.example/pl.mp4',
  },
];

test('spreadDays matches the client Mon/Wed/Fri pattern for 3 days', () => {
  assert.deepEqual(spreadDays(3), [0, 2, 4]);
});

test('buildCatalogPlanDays returns sets and hold/reps per exercise', () => {
  const days = buildCatalogPlanDays({
    catalog: sampleCatalog,
    durationMin: 12,
    daysPerWeek: 1,
    focusAreas: ['full_body'],
  });
  assert.equal(days.length, 1);
  assert.ok(days[0].exercises.length >= 1);
  const first = days[0].exercises[0];
  assert.equal(first.sets, 3);
  assert.ok(first.holdSeconds != null || first.reps != null);
});

test('enrichAiDays merges AI sets with catalog metadata', () => {
  const days = enrichAiDays(
    [{
      weekday: 0,
      exercises: [
        { slug: 'bodyweight-squat', sets: 4, reps: 15 },
        { slug: 'plank-hold', sets: 3, holdSeconds: 45 },
      ],
    }],
    sampleCatalog,
    { durationMin: 25, daysPerWeek: 1, focusAreas: ['legs'] },
  );
  assert.equal(days.length, 1);
  assert.equal(days[0].exercises[0].sets, 4);
  assert.equal(days[0].exercises[0].reps, 15);
  assert.equal(days[0].exercises[0].name, 'Bodyweight Squats');
  assert.equal(days[0].exercises[1].holdSeconds, 45);
});
