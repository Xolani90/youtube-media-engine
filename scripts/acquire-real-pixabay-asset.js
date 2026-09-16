// Manual, opt-in, one-shot script. NOT part of `npm test`, NOT run at
// application startup, NOT part of the autonomous runner.
//
// Purpose: prove that PixabayAssetSourceProvider can acquire ONE real
// asset from the real Pixabay API -- a real search request, a real
// download to a local file, a real SHA-256 checksum -- using an
// explicitly-provided real API key. Mirrors the existing real Groq
// harnesses (scripts/generate-real-brief.js, scripts/generate-real-script.js)
// in shape and discipline: nothing here is wired into Media Production,
// Asset Provisioning (which does not exist yet), or the runner.
//
// Usage:
//   PIXABAY_API_KEY=... node scripts/acquire-real-pixabay-asset.js ["search query"] [image|video_clip]
//
// Exit code is 0 only on a genuinely acquired real asset. Any failure --
// missing key, no results, a rejected/failed download -- exits non-zero
// with the real reason printed. The API key itself is never printed.

import { PixabayAssetSourceProvider } from '../src/providers/asset/PixabayAssetSourceProvider.js';

async function main() {
  if (!process.env.PIXABAY_API_KEY) {
    console.error('PIXABAY_API_KEY is not set in the environment. Aborting -- no key, no live call.');
    process.exitCode = 1;
    return;
  }

  const query = process.argv[2] ?? 'mountain landscape';
  const requestedType = process.argv[3] === 'video_clip' ? 'video_clip' : 'image';

  const provider = new PixabayAssetSourceProvider();

  const healthy = await provider.healthCheck();
  if (!healthy) {
    console.error('healthCheck() reported unhealthy despite PIXABAY_API_KEY being set. Aborting.');
    process.exitCode = 1;
    return;
  }

  console.log(`Provider: ${provider.id}`);
  console.log(`Query: "${query}"`);
  console.log(`Requested asset type: ${requestedType}`);

  let result;
  try {
    result = await provider.acquireVisualAsset({ query, assetTypes: [requestedType] });
  } catch (err) {
    console.error(`acquireVisualAsset() threw: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  if (!result) {
    console.error('acquireVisualAsset() returned null -- no asset was acquired.');
    process.exitCode = 1;
    return;
  }

  console.log(`Asset type: ${result.assetType}`);
  console.log(`Local path: ${result.location}`);
  console.log(`Checksum (sha256): ${result.checksum}`);
  console.log(`Origin (Pixabay page): ${result.origin}`);
  console.log(`License: ${result.license}`);
  console.log(`Attribution required: ${result.attributionRequired}`);
  console.log(`Verification status: ${result.verificationStatus}`);
  console.log(`Provenance notes: ${result.provenanceNotes}`);
  console.log('\nSuccess: one real asset acquired from the live Pixabay API.');
}

main();
