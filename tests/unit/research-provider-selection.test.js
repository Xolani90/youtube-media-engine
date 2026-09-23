import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectDefaultResearchSourceProvider } from '../../src/index.js';
import { TavilySearchProvider } from '../../src/providers/research/TavilySearchProvider.js';
import { GoogleNewsRssSearchProvider } from '../../src/providers/research/GoogleNewsRssSearchProvider.js';

function withTavilyKey(value, fn) {
  const previous = process.env.TAVILY_API_KEY;
  if (value === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = previous;
  }
}

test('selects GoogleNewsRssSearchProvider (R0 default) when TAVILY_API_KEY is not configured', () => {
  withTavilyKey(undefined, () => {
    const provider = selectDefaultResearchSourceProvider();
    assert.ok(provider instanceof GoogleNewsRssSearchProvider);
  });
});

test('selects TavilySearchProvider when TAVILY_API_KEY is configured', () => {
  withTavilyKey('tvly-test-key', () => {
    const provider = selectDefaultResearchSourceProvider();
    assert.ok(provider instanceof TavilySearchProvider);
  });
});
