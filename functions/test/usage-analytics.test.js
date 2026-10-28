const test = require('node:test');
const assert = require('node:assert/strict');
const {
  aggregateDailyValues,
  buildMonitoringFilter,
  calculateStorageMonthlyEstimate,
  decryptSnapshot,
  encryptSnapshot,
  estimateVariableCost,
  getCompletedDayRange,
  makeDailyRow,
  MONITORING_METRICS,
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

test('usage monitoring only requests Messenger-owned Cloud Run metrics', () => {
  assert.deepEqual(Object.keys(MONITORING_METRICS).sort(), [
    'functionCpuVcpuSeconds', 'functionMemoryGibibyteSeconds', 'functionRequests', 'functionSentBytes',
    'messengerRtdbSentBytes', 'messengerRtdbStoredBytes',
  ]);
  assert.ok(Object.values(MONITORING_METRICS).filter((metric) => metric.resourceType === 'cloud_run_revision').every((metric) => metric.messengerFunctions === true));
  assert.equal(MONITORING_METRICS.messengerRtdbSentBytes.resourceType, 'firebase_namespace');
  assert.equal(MONITORING_METRICS.messengerRtdbStoredBytes.resourceType, 'firebase_namespace');
  assert.match(buildMonitoringFilter(MONITORING_METRICS.messengerRtdbSentBytes), /resource\.labels\.table_name = "streamer-messenger-rtdb"/);
  assert.match(buildMonitoringFilter(MONITORING_METRICS.messengerRtdbStoredBytes), /metric\.type = "firebasedatabase\.googleapis\.com\/storage\/total_bytes"/);
});

test('legacy shared RTDB metrics are stripped from each newly generated day', () => {
  const row = makeDailyRow('2026-10-28', {
    rtdbDownloadedBytes: 123,
    rtdbPersistedBytes: 456,
    rtdbStoredBytes: 789,
    functionRequests: 10,
  });
  assert.deepEqual(row, {
    day: '2026-10-28',
    functionRequests: 10,
    functionCpuVcpuSeconds: null,
    functionMemoryGibibyteSeconds: null,
    functionSentBytes: null,
    messengerRtdbSentBytes: null,
    messengerRtdbStoredBytes: null,
  });
});

test('database storage gauge keeps the latest daily sample per database', () => {
  const values = aggregateDailyValues([{
    resource: { labels: { table_name: 'streamer-messenger-rtdb' } },
    points: [
      { interval: { endTime: '2026-10-27T02:00:00.000Z' }, value: { int64Value: '100' } },
      { interval: { endTime: '2026-10-27T03:00:00.000Z' }, value: { int64Value: '125' } },
      { interval: { endTime: '2026-10-28T03:00:00.000Z' }, value: { int64Value: '150' } },
    ],
  }], { gauge: true });
  assert.equal(values.get('2026-10-27'), 125);
  assert.equal(values.get('2026-10-28'), 150);
});

test('variable cost includes Messenger Functions and dedicated RTDB network transfer', () => {
  const row = estimateVariableCost({
    functionRequests: 1_000_000,
    functionCpuVcpuSeconds: 100,
    functionMemoryGibibyteSeconds: 100,
    messengerRtdbSentBytes: 1_000_000_000,
  });
  assert.ok(Math.abs(row.cloudRunFunctionsUsd - 0.40265) < 1e-12);
  assert.equal(row.rtdbNetworkUsd, 1);
  assert.ok(Math.abs(row.trackedVariableUsd - 1.40265) < 1e-12);
  assert.equal(Object.hasOwn(row, 'rtdbDownloadUsd'), false);
  assert.equal(estimateVariableCost({ functionRequests: null }).trackedVariableUsd, null);
});

test('monthly storage estimate applies the dedicated Messenger R2 rate only', () => {
  const estimate = calculateStorageMonthlyEstimate(1_000_000_000, 1_000_000_000);
  assert.equal(estimate.r2UsdPerMonth, 0.015);
  assert.equal(estimate.rtdbUsdPerMonth, 5);
  assert.equal(estimate.trackedUsdPerMonth, 5.015);
  assert.equal(Object.hasOwn(estimate, 'rtdbSharedUsdPerMonth'), false);
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
