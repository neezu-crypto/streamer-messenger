const test = require('node:test');
const assert = require('node:assert/strict');
const {
  aggregateDailyGaugeSamples,
  aggregateDailyValues,
  calculateStorageMonthlyEstimate,
  decryptSnapshot,
  encryptSnapshot,
  estimateVariableCost,
  getCompletedDayRange,
} = require('../src/usage-analytics');

test('completed history is exactly the previous 30 KST days', () => {
  const range = getCompletedDayRange(Date.parse('2026-10-28T15:30:00.000Z'));
  assert.equal(range.today, '2026-10-29');
  assert.equal(range.through, '2026-10-28');
  assert.equal(range.from, '2026-09-29');
  assert.equal(Date.parse(range.endTime) - Date.parse(range.startTime), 30 * 24 * 60 * 60 * 1000);
});

test('hourly totals are bucketed by KST day including midnight boundary', () => {
  const values = aggregateDailyValues([{
    resource: { labels: { project_id: 'soop-stock-market' } },
    points: [
      { interval: { endTime: '2026-10-27T14:00:00.000Z' }, value: { int64Value: '100' } },
      { interval: { endTime: '2026-10-27T15:00:00.000Z' }, value: { int64Value: '200' } },
      { interval: { endTime: '2026-10-27T16:00:00.000Z' }, value: { int64Value: '50' } },
    ],
  }]);
  assert.equal(values.get('2026-10-27'), 300);
  assert.equal(values.get('2026-10-28'), 50);
});

test('daily storage gauges keep the latest sample per database and day', () => {
  const values = aggregateDailyGaugeSamples([
    { resource: { labels: { database_id: 'main' } }, points: [
      { interval: { endTime: '2026-10-26T15:00:00.000Z' }, value: { int64Value: '1000' } },
      { interval: { endTime: '2026-10-27T14:00:00.000Z' }, value: { int64Value: '1100' } },
    ] },
    { resource: { labels: { database_id: 'main' } }, points: [
      { interval: { endTime: '2026-10-27T15:00:00.000Z' }, value: { int64Value: '1200' } },
    ] },
    { resource: { labels: { database_id: 'secondary' } }, points: [
      { interval: { endTime: '2026-10-27T14:30:00.000Z' }, value: { int64Value: '300' } },
    ] },
  ]);
  assert.deepEqual(values.get('2026-10-27'), { value: 1400, sampledAt: Date.parse('2026-10-27T14:30:00.000Z') });
  assert.deepEqual(values.get('2026-10-28'), { value: 1200, sampledAt: Date.parse('2026-10-27T15:00:00.000Z') });
});

test('variable cost uses published gross USD rates and requires all function meters', () => {
  const row = estimateVariableCost({
    rtdbDownloadedBytes: 1_000_000_000,
    functionRequests: 1_000_000,
    functionCpuVcpuSeconds: 100,
    functionMemoryGibibyteSeconds: 100,
  });
  assert.equal(row.rtdbDownloadUsd, 1);
  assert.ok(Math.abs(row.cloudRunFunctionsUsd - 0.40265) < 1e-12);
  assert.ok(Math.abs(row.trackedVariableUsd - 1.40265) < 1e-12);
  assert.equal(estimateVariableCost({ rtdbDownloadedBytes: 0, functionRequests: null }).trackedVariableUsd, null);
});

test('monthly storage estimate applies RTDB and R2 gross storage rates', () => {
  const estimate = calculateStorageMonthlyEstimate(1_000_000_000, 1_000_000_000);
  assert.equal(estimate.rtdbSharedUsdPerMonth, 5);
  assert.equal(estimate.r2UsdPerMonth, 0.015);
  assert.equal(estimate.trackedUsdPerMonth, 5.015);
});

test('snapshot encryption authenticates content and rejects tampering', () => {
  const report = { schemaVersion: 1, daily: [{ day: '2026-10-28' }], current: { r2: { bytes: 42 } } };
  const encrypted = encryptSnapshot(report, 'test-only-secret');
  assert.deepEqual(decryptSnapshot(encrypted, 'test-only-secret'), report);
  const tampered = Buffer.from(encrypted);
  tampered[tampered.length - 1] ^= 1;
  assert.throws(() => decryptSnapshot(tampered, 'test-only-secret'));
  assert.throws(() => decryptSnapshot(encrypted, 'wrong-secret'));
});
