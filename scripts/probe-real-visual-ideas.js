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
//   INCLUDE_EXAMPLE_FIXTURES=1 node scripts/probe-real-visual-ideas.js
//
// Fixture sets: the first three fixtures (battery plant, bus/tram fares,
// coastal erosion) are the SAME topics as the three style examples inside the
// Brief prompt (src/brief/generate.js), so a model that copies the examples
// would pass them without generalizing. They are tagged `inPromptExamples`
// and skipped by default. The default run uses only the off-example fixtures
// (abstract / policy-heavy topics, where stock-keyword search is hardest).
// Default SAMPLES is the number of off-example fixtures.

import { LLMRouter } from '../src/providers/llm/router.js';
import { generateBriefFields } from '../src/brief/generate.js';
import { deriveVisualQuery } from '../src/asset-provisioning/visualQuery.js';
import { boundPixabayQuery, PIXABAY_MAX_QUERY_LENGTH } from '../src/providers/asset/PixabayAssetSourceProvider.js';

// Below this many total hits a query is flagged as thin stock coverage.
const LOW_HIT_THRESHOLD = 100;

const FIXTURES = [
  {
    inPromptExamples: true,
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
    inPromptExamples: true,
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
    inPromptExamples: true,
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
  },
  {
    coreQuestion: 'Why did the central bank leave interest rates unchanged?',
    opportunity: {
      title: 'Central bank holds interest rates steady',
      description: 'The central bank kept its benchmark rate unchanged after its latest policy meeting.'
    },
    claims: [
      'The central bank kept its benchmark interest rate unchanged at its latest meeting.',
      'The bank said inflation remains above its target range.',
      'The governor said future decisions will depend on incoming economic data.'
    ]
  },
  {
    coreQuestion: 'What does the new semiconductor export rule restrict?',
    opportunity: {
      title: 'Government tightens export rules on advanced computer chips',
      description: 'A new regulation restricts exports of advanced semiconductors to certain countries.'
    },
    claims: [
      'The government published a rule restricting exports of advanced semiconductors.',
      'The rule applies to chips above a stated processing-performance threshold.',
      'Industry groups said the rule could affect supply chains.'
    ]
  },
  {
    coreQuestion: 'What did the court decide in the data privacy ruling?',
    opportunity: {
      title: 'Court rules against company in data privacy case',
      description: 'A court issued a ruling on how a company handled customer personal data.'
    },
    claims: [
      'The court ruled that the company failed to obtain valid consent for data collection.',
      'The court ordered the company to pay a fine.',
      'The company said it will appeal the decision.'
    ]
  },
  {
    coreQuestion: 'Why did the national unemployment rate change last quarter?',
    opportunity: {
      title: 'National unemployment rate edges up',
      description: 'Official statistics showed a small rise in the unemployment rate.'
    },
    claims: [
      'The statistics agency reported the unemployment rate rose by 0.2 percentage points.',
      'The increase was concentrated among workers under 25.',
      'Economists said hiring slowed in the retail and services sectors.'
    ]
  },
  {
    coreQuestion: 'What does the new vaccine approval mean for the health system?',
    opportunity: {
      title: 'Regulator approves new vaccine for older adults',
      description: 'A health regulator approved a new vaccine for people over 60.'
    },
    claims: [
      'The health regulator approved a new vaccine for adults aged 60 and over.',
      'The approval was based on results from a late-stage clinical trial.',
      'Health officials said rollout will begin through clinics next season.'
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
  const includeExamples = process.env.INCLUDE_EXAMPLE_FIXTURES === '1';
  const pool = includeExamples ? FIXTURES : FIXTURES.filter((f) => !f.inPromptExamples);
  const samples = Math.min(Number(process.env.SAMPLES || pool.length), pool.length);
  console.log(`Fixture set: ${includeExamples ? 'ALL (includes prompt-example topics)' : 'off-example only'}; running ${samples} of ${pool.length}.`);
  const llmRouter = new LLMRouter({ priority: ['gemini-free'] });
  let over = 0;
  let parsedCount = 0;
  let zeroHit = 0;
  let lowHit = 0;
  let pixabayFailed = 0;

  for (let i = 0; i < samples; i++) {
    const f = pool[i];
    console.log(`\n== Sample ${i + 1}/${samples}: ${f.opportunity.title}${f.inPromptExamples ? '  [overlaps prompt example]' : ''}`);
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
    if (hits.total === 0) zeroHit++;
    else if (hits.total !== undefined && hits.total < LOW_HIT_THRESHOLD) lowHit++;
    else if (hits.total === undefined) pixabayFailed++;
  }

  console.log(`\nSummary: ${parsedCount} parsed sample(s); ${over} had a derived query over ${PIXABAY_MAX_QUERY_LENGTH} characters.`);
  console.log(`Coverage: ${zeroHit} zero-hit, ${lowHit} low-hit (<${LOW_HIT_THRESHOLD}), ${pixabayFailed} without a hit count (skipped or HTTP error).`);
  console.log('Reading it: over > 0 confirms the long-query defect on real LLM output; "total hits 0" on a bounded query means a long sentence is still a poor Pixabay keyword search.');
}

main().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  process.exitCode = 1;
});
