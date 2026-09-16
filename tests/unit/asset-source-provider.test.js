import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AssetSourceProvider } from '../../src/providers/asset/AssetSourceProvider.js';

// Milestone A: interface/contract only. No concrete provider exists yet,
// so this test pins down the base-class contract itself (mirrors the
// discipline other interfaces in this repo rely on, even though neither
// ResearchSourceProvider nor LLMProvider has its own dedicated test file
// today -- both are exercised only indirectly via stub subclasses in
// consumer tests, which do not yet exist for this interface).

test('AssetSourceProvider.id throws when not implemented by a subclass', () => {
  const provider = new AssetSourceProvider();
  assert.throws(() => provider.id, /must be implemented by subclass/);
});

test('AssetSourceProvider.healthCheck() rejects when not implemented by a subclass', async () => {
  const provider = new AssetSourceProvider();
  await assert.rejects(() => provider.healthCheck(), /must be implemented by subclass/);
});

test('AssetSourceProvider.acquireVisualAsset() rejects when not implemented by a subclass', async () => {
  const provider = new AssetSourceProvider();
  await assert.rejects(
    () => provider.acquireVisualAsset({ query: 'a lighthouse at dusk', assetTypes: ['image'] }),
    /must be implemented by subclass/
  );
});

class StubAssetSourceProvider extends AssetSourceProvider {
  constructor(result) {
    super();
    this.result = result;
  }
  get id() {
    return 'stub-asset-source';
  }
  async healthCheck() {
    return true;
  }
  async acquireVisualAsset() {
    return this.result;
  }
}

test('a subclass can satisfy the full contract (id, healthCheck, acquireVisualAsset)', async () => {
  const candidate = {
    assetType: 'image',
    location: '/tmp/example.jpg',
    checksum: null,
    origin: null,
    license: null,
    attributionRequired: false,
    attributionText: null,
    usageRestrictions: null,
    provenanceNotes: null,
    verificationStatus: 'UNVERIFIED'
  };
  const provider = new StubAssetSourceProvider(candidate);

  assert.equal(provider.id, 'stub-asset-source');
  assert.equal(await provider.healthCheck(), true);
  const acquired = await provider.acquireVisualAsset({ query: 'a lighthouse at dusk', assetTypes: ['image'] });
  assert.deepEqual(acquired, candidate);
});

test('acquireVisualAsset() may return null (no suitable asset found is not an error)', async () => {
  const provider = new StubAssetSourceProvider(null);
  const acquired = await provider.acquireVisualAsset({ query: 'something obscure', assetTypes: ['image'] });
  assert.equal(acquired, null);
});
