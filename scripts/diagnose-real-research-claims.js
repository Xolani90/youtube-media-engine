// TEMPORARY, READ-ONLY DIAGNOSTIC. Not part of npm test, not part of the
// autonomous runner, not a replacement for scripts/generate-real-research.js.
//
// Purpose: call the real, unmodified extractClaims() from
// src/research/claims.js exactly once, against real 'groq-free', using the
// same essential source text / core question as the Research harness, and
// print the RAW returned values with no normalization, repair, trimming,
// or regex extraction -- so a human can see exactly what Groq returned and
// distinguish (A) malformed/wrapped JSON, (B) valid JSON with no
// load-bearing claims, (C) valid claims rejected structurally, or (D)
// something else.
//
// This makes no persistence, no storage, no pipeline calls, and touches no
// production file. It imports two existing, unmodified production exports
// (extractClaims, LLMRouter) and calls them exactly as documented.
//
// Usage:
//   GROQ_FREE_API_KEY=... node scripts/diagnose-real-research-claims.js

import { extractClaims } from '../src/research/claims.js';
import { LLMRouter } from '../src/providers/llm/router.js';

async function main() {
  const apiKey = process.env.GROQ_FREE_API_KEY;
  if (!apiKey) {
    console.error(
      'FAILED: GROQ_FREE_API_KEY is not set in the process environment.\n' +
      'This diagnostic requires a real key and will not fall back to any other provider.'
    );
    process.exitCode = 1;
    return;
  }

  // Same essential source text and core question as
  // scripts/generate-real-research.js's fixture.
  const sourceText = 'Acme reported one billion dollars in Q3 revenue following the product launch.';
  const coreQuestion = 'Did the product launch cause a measurable sales increase?';

  // Explicitly limited to groq-free only -- no fallback to any other
  // provider id.
  const llmRouter = new LLMRouter({ priority: ['groq-free'] });

  console.log('Calling extractClaims() once via provider: groq-free ...');
  const extraction = await extractClaims({ sourceText, coreQuestion }, llmRouter);

  console.log('\n=== provider metadata ===');
  console.log('providerUsed:', extraction.providerUsed);
  console.log('model:', extraction.model);
  console.log('estimatedCost:', extraction.estimatedCost);
  console.log('isPaid:', extraction.isPaid);

  console.log('\n=== rawOutput (EXACTLY as returned by extractClaims(), unmodified) ===');
  console.log(extraction.rawOutput);
  console.log('=== end rawOutput ===');

  console.log('\n=== parsed claims (EXACTLY as returned by extractClaims()) ===');
  console.log(JSON.stringify(extraction.claims, null, 2));

  console.log('\n=== claim count ===');
  console.log(extraction.claims.length);

  console.log('\n=== per-claim fields ===');
  extraction.claims.forEach((c, i) => {
    console.log(`claim[${i}]:`);
    console.log('  claim:', c.claim);
    console.log('  claim_type:', c.claim_type);
    console.log('  is_load_bearing:', c.is_load_bearing);
  });

  console.log('\n=== JSON.parse(rawOutput) validity (independent check, not extractClaims\' internal parse) ===');
  try {
    JSON.parse(extraction.rawOutput);
    console.log('rawOutput IS valid JSON according to JSON.parse.');
  } catch (err) {
    console.log('rawOutput is NOT valid JSON according to JSON.parse.');
    console.log('parse error message:', err.message);
  }
}

main().catch((err) => {
  console.error('FAILED: unexpected error while running the diagnostic.');
  console.error(err.stack || err.message || err);
  process.exitCode = 1;
});
