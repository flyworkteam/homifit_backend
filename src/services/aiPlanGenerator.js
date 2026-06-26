const { pool } = require('../config/db');
const {
  FOCUS_AREA_SLUGS,
  loadCatalogExercises,
  buildCatalogPlanDays,
  enrichAiDays,
  spreadDays,
  recommendDaysPerWeek,
} = require('./catalogPlanBuilder');

const GOALS = new Set(['lose_weight', 'build_muscle', 'stay_fit', 'boost_energy']);
const LEVELS = new Set(['beginner', 'intermediate', 'advanced']);

function compactCatalogForPrompt(catalog, focusAreas) {
  const muscles = focusAreas.length > 0 ? focusAreas : ['full_body'];
  const seen = new Set();
  const out = [];
  for (const m of muscles) {
    for (const e of catalog) {
      if (seen.has(e.slug)) continue;
      const pm = String(e.primaryMuscle || '').toLowerCase();
      const match = m === 'full_body'
        || pm === m
        || (m === 'shoulders' && pm.includes('shoulder'))
        || (m === 'back' && (pm.includes('back') || pm.includes('shoulder')))
        || (m === 'glutes' && pm.includes('glute'))
        || (m === 'legs' && pm.includes('leg'))
        || pm.includes(m);
      if (!match) continue;
      seen.add(e.slug);
      out.push({
        slug: e.slug,
        name: e.name,
        unit: e.unit,
        muscle: e.primaryMuscle,
      });
    }
  }
  if (out.length === 0) {
    return catalog.slice(0, 120).map((e) => ({
      slug: e.slug,
      name: e.name,
      unit: e.unit,
      muscle: e.primaryMuscle,
    }));
  }
  return out.slice(0, 160);
}

function buildDayBlueprint({ daysPerWeek, focusAreas, durationMin }) {
  const weekdays = spreadDays(daysPerWeek);
  const muscles = focusAreas.length > 0 ? focusAreas : ['full_body'];
  const perDay = Math.max(3, Math.min(8, Math.round(durationMin / 4)));
  return weekdays.map((weekday, i) => ({
    weekday,
    focusMuscle: muscles[i % muscles.length],
    exerciseCount: perDay,
  }));
}

function buildPrompt({
  locale,
  goal,
  level,
  durationMin,
  daysPerWeek,
  focusAreas,
  warmupEnabled,
  stretchingEnabled,
  equipmentEnabled,
  catalog,
}) {
  const blueprint = buildDayBlueprint({ daysPerWeek, focusAreas, durationMin });
  return `You are a certified personal trainer building a weekly workout plan for a fitness app.

User profile:
- goal: ${goal || 'stay_fit'}
- level: ${level || 'intermediate'}
- session length: ${durationMin} minutes
- training days per week: ${daysPerWeek}
- focus areas: ${(focusAreas.length ? focusAreas : ['full_body']).join(', ')}
- warmup: ${warmupEnabled ? 'yes' : 'no'}
- stretching: ${stretchingEnabled ? 'yes' : 'no'}
- equipment available: ${equipmentEnabled ? 'yes' : 'bodyweight only'}
- locale: ${locale || 'en'}

Schedule blueprint (follow exactly):
${JSON.stringify(blueprint)}

Allowed exercises (use ONLY these slugs):
${JSON.stringify(catalog)}

Rules:
1. Return JSON: {"days":[{"weekday":0,"exercises":[{"slug":"...","sets":3,"reps":12}]}]}
2. For each exercise, include sets (1-5) and EITHER reps (8-20) OR holdSeconds (15-60) — never both.
3. Match reps vs holdSeconds to the exercise unit from the catalog (unit=seconds → holdSeconds only).
4. Personalize sets/reps/holdSeconds to goal and level (beginner=easier, advanced=harder).
5. No duplicate slugs within a day; vary exercises across days when possible.
6. Each day must have exactly the exerciseCount from the blueprint.
7. Prefer compound moves for muscle days; include cardio-style holds for lose_weight when appropriate.`;
}

async function callOpenAi(prompt) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.OPENAI_PLAN_MODEL || 'gpt-4o-mini',
        temperature: 0.6,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content: 'You output only valid JSON for workout plans. No markdown.',
          },
          { role: 'user', content: prompt },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`OpenAI ${res.status}: ${text.slice(0, 200)}`);
    }
    const body = await res.json();
    const content = body?.choices?.[0]?.message?.content;
    if (!content) throw new Error('OpenAI empty response');
    return JSON.parse(content);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeInput(body = {}) {
  const focusAreas = Array.isArray(body.focusAreas)
    ? body.focusAreas.map(String).filter((v) => FOCUS_AREA_SLUGS.has(v))
    : [];
  const goal = body.goal && GOALS.has(String(body.goal)) ? String(body.goal) : null;
  const level = body.level && LEVELS.has(String(body.level)) ? String(body.level) : null;
  const durationMin = Math.max(5, Math.min(240, Number.parseInt(body.durationMin, 10) || 25));
  // Flutter now seeds daysPerWeek from the user's goal + level on the onboarding
  // path, so requestedDays is already the correct count. Honor it directly.
  const daysPerWeek = Math.max(1, Math.min(7, Number.parseInt(body.daysPerWeek, 10) || 3));
  return {
    locale: String(body.locale || 'en'),
    goal,
    level,
    durationMin,
    daysPerWeek,
    focusAreas,
    warmupEnabled: body.warmupEnabled === true,
    stretchingEnabled: body.stretchingEnabled !== false,
    equipmentEnabled: body.equipmentEnabled === true,
  };
}

/**
 * Generate rich plan days (sets / reps / holdSeconds + thumbnails) via OpenAI,
 * falling back to the deterministic catalog builder when AI is unavailable.
 */
async function generateAiPlanDays(rawInput) {
  const input = normalizeInput(rawInput);
  const catalog = await loadCatalogExercises(pool, input.locale);
  if (catalog.length === 0) {
    throw new Error('exercise catalog empty');
  }

  const compact = compactCatalogForPrompt(catalog, input.focusAreas);
  let aiDays = null;

  try {
    const prompt = buildPrompt({ ...input, catalog: compact });
    const parsed = await callOpenAi(prompt);
    aiDays = parsed?.days;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[aiPlanGenerator] OpenAI failed, using catalog fallback:', err.message);
  }

  if (Array.isArray(aiDays) && aiDays.length > 0) {
    return enrichAiDays(aiDays, catalog, input);
  }

  return buildCatalogPlanDays({
    catalog,
    durationMin: input.durationMin,
    daysPerWeek: input.daysPerWeek,
    focusAreas: input.focusAreas,
  });
}

module.exports = {
  generateAiPlanDays,
  normalizeInput,
};
