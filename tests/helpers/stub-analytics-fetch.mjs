// Test-only preload: replaces global fetch with an API-shaped YouTube Analytics fake.
// STUB_SCENARIO: OK | AUDIENCE_400 | AUDIENCE_403 | SCALAR_400 | BOTH_400
const sc = process.env.STUB_SCENARIO || 'OK';
const j = (status, body) => ({ ok: status === 200, status, json: async () => body, text: async () => JSON.stringify(body) });
const RET_H = [{ name: 'elapsedVideoTimeRatio' }, { name: 'audienceWatchRatio' }, { name: 'relativeRetentionPerformance' }];
const TRAF_H = [{ name: 'insightTrafficSourceType' }, { name: 'views' }, { name: 'estimatedMinutesWatched' }];
const BASE_H = ['video', 'views', 'likes', 'comments', 'shares', 'estimatedMinutesWatched', 'averageViewDuration', 'averageViewPercentage', 'impressions', 'impressionsClickThroughRate'].map((name) => ({ name }));
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.startsWith('https://oauth2.googleapis.com/token')) return j(200, { access_token: 'tok' });
  if (!u.startsWith('https://youtubeanalytics.googleapis.com/')) throw new Error(`stub: unexpected network call ${u}`);
  const q = new URL(u).searchParams;
  const dims = q.get('dimensions');
  const ids = (q.get('filters') ?? '').replace('video==', '').split(',');
  if (dims === 'video') {
    if (sc === 'SCALAR_400' || sc === 'BOTH_400') return j(400, { error: { code: 400 } });
    return j(200, { columnHeaders: BASE_H, rows: ids.map((id) => [id, 100, 5, 1, 0, 50, 30, 40, 5000, 4]) });
  }
  if (sc === 'AUDIENCE_400' || sc === 'BOTH_400') return j(400, { error: { code: 400 } });
  if (sc === 'AUDIENCE_403') return j(403, { error: { code: 403 } });
  if (dims === 'elapsedVideoTimeRatio') return j(200, { columnHeaders: RET_H, rows: Array.from({ length: 100 }, (_, i) => [((i + 1) / 100).toFixed(2), 1 - (i + 1) / 200, 0.5]) });
  return j(200, { columnHeaders: TRAF_H, rows: [['YT_SEARCH', 500, 200], ['RELATED_VIDEO', 300, 100]] });
};
