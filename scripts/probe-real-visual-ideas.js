// Manual, opt-in, one-shot probe. NOT part of `npm test`, NOT part of the
// autonomous runner, writes nothing to any database.
//
// Question answered: what does a REAL Gemini completion put in the Brief's
// `visual_ideas` field, and what does the asset-provisioning path then send
// to Pixabay? This avoids the Research stage entirely: it calls the real,
// unmodified generateBriefFields() (the exact Brief prompt) with a few
// seeded eligible claims, then runs the real deriveVisualQuery() and the
// real boundPixabayQuery() on the result, and (if PIXABAY_API_KEY is set)
// asks Pixabay how many hits the bounded query gets.
//
// Cost: one LLM call per sample (default 3), each paced by the provider's
// own 4.5s floor. No fallback to any other provider.
//
// Usage:
//   GEMINI_FREE_API_KEY=... node scripts/probe-real-visual-ideas.js
//   SAMPLES=5 node scripts/probe-real-visual-ideas.js

import { LLMRouter } from '../src/providers/llm/router.js';
import { generateBriefFields } from '../src/brief/generate.js';
import { deriveVisualQuery } from '../src/asset-provisioning/visualQuery.js';
import { boundPixabayQuery, PIXABAY_MAX_QUERY_LENGTH } from '../src/providers/asset/PixabayAssetSourceProvider.js';

const FIXTURES = [
  {
    coreQuestion: 'Did the new battery plant announcement change local hiring plans?',
    opportunity: {
      title: 'Battery plant announced near a mid-sized town',
      description: 'A manufacturer announced a new battery plant and said it will create jobs.'
    },
    claims: [
      'The company announced a new battery manufacturing plant in March 2026.',
      'The company said the plant will employ about 2,000 people at full capacity.',
      'Local officials said construction is expected to take two years.'
    ]
  },
  {
    coreQuestion: 'Why did the city change its public transport fares?',
    opportunity: {
      title: 'City raises bus and tram fares',
      description: 'The city council voted to raise public transport fares from next quarter.'
    },
    claims: [
      'The city council voted to raise single-ticket fares by 10 percent.',
      'The council said the increase will fund maintenance of the tram network.',
      'Passenger numbers fell in the previous year according to the transport authority.'
    ]
  },
  {
    coreQuestion: 'What did the new coastal erosion report find?',
    opportunity: {
      title: 'Report on coastal erosion along the northern coastline',
      description: 'A government agency published a report on coastal erosion rates.'
    },
    claims: [
      'The agency published a coastal erosion report covering the northern coastline.',
      'The report found erosion rates increased over the last decade.',
      'The report recommended new monitoring stations at several sites.'
    ]
  }
];

async function pixabayHits(query) {
  const key = process.env.PIXABAY_API_KEY;
  if (!key) return { status: 'skipped (PIXABAY_API_KEY not set)' };
  const url = new URL('https://pixabay.com/api/');
  url.searchParams.set('key', key);
  url.searchParams.set('q', query);
  url.searchParams.set('per_page', '3');
  const res = await fetch(url);
  if (!res.ok) return { status: `HTTP ${res.status}` };
  const body = await res.json();
  return { status: 'HTTP 200', total: body.total };
}

async function main() {
  if (!process.env.GEMINI_FREE_API_KEY) {
    console.error('FAILED: GEMINI_FREE_API_KEY is not set. No fallback provider is used.');
    process.exitCode = 1;
    return;
  }
  const samples = Math.min(Number(process.env.SAMPLES || 3), FIXTURES.length);
  const llmRouter = new LLMRouter({ priority: ['gemini-free'] });
  let over = 0;
  let parsedCount = 0;

  for (let i = 0; i < samples; i++) {
    const f = FIXTURES[i];
    console.log(`\n== Sample ${i + 1}/${samples}: ${f.opportunity.title}`);
    let out;
    try {
      out = await generateBriefFields(
        {
          coreQuestion: f.coreQuestion,
          opportunity: f.opportunity,
          eligibleClaims: f.claims.map((claim, n) => ({ id: `claim-${i + 1}-${n + 1}`, claim, claim_type: 'FACT' }))
        },
        llmRouter
      );
    } catch (err) {
      console.log(`  LLM call failed: ${err.message}`);
      continue;
    }
    const visual = out.parsed && typeof out.parsed.visual_ideas === 'string' ? out.parsed.visual_ideas : null;
    if (visual === null) {
      console.log('  no parsable visual_ideas in the response (malformed or missing)');
      continue;
    }
    parsedCount++;
    const derived = deriveVisualQuery({ visual_ideas: visual }, { body: '' });
    const bounded = boundPixabayQuery(derived);
    if (derived.length > PIXABAY_MAX_QUERY_LENGTH) over++;
    console.log(`  visual_ideas length: ${visual.length}`);
    console.log(`  visual_ideas (first 200): ${JSON.stringify(visual.slice(0, 200))}`);
    console.log(`  derived query length: ${derived.length}  (Pixabay limit ${PIXABAY_MAX_QUERY_LENGTH})`);
    console.log(`  sent to Pixabay after bound (${bounded.length}): ${JSON.stringify(bounded)}`);
    const hits = await pixabayHits(bounded);
    console.log(`  Pixabay for bounded query: ${hits.status}${hits.total !== undefined ? `, total hits ${hits.total}` : ''}`);
  }

  console.log(`\nSummary: ${parsedCount} parsed sample(s); ${over} had a derived query over ${PIXABAY_MAX_QUERY_LENGTH} characters.`);
  console.log('Reading it: over > 0 confirms the long-query defect on real LLM output; "total hits 0" on a bounded query means a long sentence is still a poor Pixabay keyword search.');
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  process.exitCode = 1;
});
