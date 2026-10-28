const crypto = require('node:crypto');
const { GoogleAuth } = require('google-auth-library');
const {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} = require('@aws-sdk/client-s3');

const PROJECT_ID = 'soop-stock-market';
const BUCKET = 'streamer-messenger-private';
const SNAPSHOT_KEY = 'operational-usage/last-30-days.v1.enc';
const HISTORY_DAYS = 30;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const MAX_R2_LIST_PAGES = 200;
const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const COST_RATES = Object.freeze({
  currency: 'USD',
  effectiveDate: '2026-10-29',
  rtdbDownloadUsdPerGb: 1,
  rtdbStorageUsdPerGbMonth: 5,
  cloudRunCpuUsdPerVcpuSecond: 0.000024,
  cloudRunMemoryUsdPerGibibyteSecond: 0.0000025,
  cloudRunRequestUsdPerMillion: 0.4,
  r2StorageUsdPerGbMonth: 0.015,
  r2ClassAUsdPerMillion: 4.5,
  notes: [
    'Google Cloud/Firebase 공용 무료 허용량, 할인, 세금은 반영하지 않은 공개 단가 기준 추정치입니다.',
    'Realtime Database 사용량·저장량은 자매 서비스와 공유되는 프로젝트 전체 값이며 메신저만의 사용량이 아닙니다.',
    'Cloud Run Functions 값은 메신저 이름으로 배포된 Functions의 Monitoring 집계이며 외부 네트워크 전송료는 제외합니다.',
    'R2 비용은 현재 저장량 기준 저장료만 계산하며 애플리케이션 전체 R2 요청 수는 제공되지 않습니다.',
    'GitHub Pages 정적 파일, 브라우저 캐시, SOOP/YouTube/Discord 등 외부 서비스 트래픽은 포함되지 않습니다.',
  ],
  sources: {
    firebasePricing: 'https://firebase.google.com/pricing',
    rtdbBilling: 'https://firebase.google.com/docs/database/usage/billing',
    cloudRunPricing: 'https://cloud.google.com/run/pricing',
    r2Pricing: 'https://developers.cloudflare.com/r2/pricing/',
  },
});

const MONITORING_METRICS = Object.freeze({
  rtdbDownloadedBytes: {
    type: 'firebasedatabase.googleapis.com/network/sent_bytes_count',
    resourceType: 'firebase_namespace',
    align: true,
  },
  rtdbPersistedBytes: {
    type: 'firebasedatabase.googleapis.com/io/persisted_bytes_count',
    resourceType: 'firebase_namespace',
    align: true,
  },
  rtdbStoredBytes: {
    type: 'firebasedatabase.googleapis.com/storage/total_bytes',
    resourceType: 'firebase_namespace',
    gauge: true,
  },
  functionRequests: {
    type: 'run.googleapis.com/request_count',
    resourceType: 'cloud_run_revision',
    messengerFunctions: true,
    align: true,
  },
  functionCpuVcpuSeconds: {
    type: 'run.googleapis.com/container/cpu/allocation_time',
    resourceType: 'cloud_run_revision',
    messengerFunctions: true,
    align: true,
  },
  functionMemoryGibibyteSeconds: {
    type: 'run.googleapis.com/container/memory/allocation_time',
    resourceType: 'cloud_run_revision',
    messengerFunctions: true,
    align: true,
  },
  functionSentBytes: {
    type: 'run.googleapis.com/container/network/sent_bytes_count',
    resourceType: 'cloud_run_revision',
    messengerFunctions: true,
    align: true,
  },
});

function kstDayKey(epochMs) {
  return new Date(Number(epochMs) + KST_OFFSET_MS).toISOString().slice(0, 10);
}

function addDays(day, amount) {
  const [year, month, date] = String(day).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date + amount)).toISOString().slice(0, 10);
}

function kstMidnightIso(day) {
  const [year, month, date] = String(day).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date) - KST_OFFSET_MS).toISOString();
}

function getCompletedDayRange(nowMs = Date.now()) {
  const today = kstDayKey(nowMs);
  const through = addDays(today, -1);
  const from = addDays(through, -(HISTORY_DAYS - 1));
  return { today, from, through, startTime: kstMidnightIso(from), endTime: kstMidnightIso(today) };
}

function makeDailyRow(day, previous) {
  const old = previous || {};
  return {
    day,
    rtdbDownloadedBytes: finiteOrNull(old.rtdbDownloadedBytes),
    rtdbPersistedBytes: finiteOrNull(old.rtdbPersistedBytes),
    rtdbStoredBytes: finiteOrNull(old.rtdbStoredBytes),
    rtdbStorageSampledAt: old.rtdbStorageSampledAt || null,
    functionRequests: finiteOrNull(old.functionRequests),
    functionCpuVcpuSeconds: finiteOrNull(old.functionCpuVcpuSeconds),
    functionMemoryGibibyteSeconds: finiteOrNull(old.functionMemoryGibibyteSeconds),
    functionSentBytes: finiteOrNull(old.functionSentBytes),
  };
}

function finiteOrNull(value) {
  const numeric = Number(value);
  return value !== null && value !== undefined && Number.isFinite(numeric) ? numeric : null;
}

function parsePointValue(value) {
  if (!value) return null;
  for (const key of ['int64Value', 'doubleValue', 'distributionValue']) {
    if (key === 'distributionValue') continue;
    if (value[key] !== undefined && value[key] !== null) {
      const numeric = Number(value[key]);
      return Number.isFinite(numeric) ? numeric : null;
    }
  }
  return null;
}

function pointEndTime(point) {
  const raw = point && point.interval && point.interval.endTime;
  const timestamp = Date.parse(raw || '');
  return Number.isFinite(timestamp) ? timestamp : null;
}

function aggregateDailyValues(seriesList, { gauge = false } = {}) {
  const values = new Map();
  const latestByDayAndResource = new Map();
  for (const series of seriesList || []) {
    const resourceKey = String((series.resource && series.resource.labels && (series.resource.labels.database_id || series.resource.labels.project_id || series.resource.labels.service_name)) || 'resource');
    for (const point of series.points || []) {
      const end = pointEndTime(point);
      const value = parsePointValue(point.value);
      if (end === null || value === null) continue;
      const day = kstDayKey(gauge ? end : end - 1);
      if (gauge) {
        const key = `${day}\0${resourceKey}`;
        const existing = latestByDayAndResource.get(key);
        if (!existing || end > existing.end) latestByDayAndResource.set(key, { day, end, value });
      } else {
        values.set(day, (values.get(day) || 0) + value);
      }
    }
  }
  if (gauge) {
    const perDay = new Map();
    for (const point of latestByDayAndResource.values()) perDay.set(point.day, (perDay.get(point.day) || 0) + point.value);
    for (const [day, value] of perDay) values.set(day, value);
  }
  return values;
}

function aggregateDailyGaugeSamples(seriesList) {
  const latestByDayAndResource = new Map();
  for (const series of seriesList || []) {
    const resourceKey = String((series.resource && series.resource.labels && (series.resource.labels.database_id || series.resource.labels.project_id)) || 'database');
    for (const point of series.points || []) {
      const end = pointEndTime(point);
      const value = parsePointValue(point.value);
      if (end === null || value === null) continue;
      const day = kstDayKey(end);
      const key = `${day}\0${resourceKey}`;
      const existing = latestByDayAndResource.get(key);
      if (!existing || end > existing.end) latestByDayAndResource.set(key, { day, end, value });
    }
  }
  const result = new Map();
  for (const sample of latestByDayAndResource.values()) {
    const current = result.get(sample.day) || { value: 0, sampledAt: 0 };
    current.value += sample.value;
    current.sampledAt = Math.max(current.sampledAt, sample.end);
    result.set(sample.day, current);
  }
  return result;
}

function buildMonitoringFilter(metric) {
  const parts = [`metric.type = "${metric.type}"`, `resource.type = "${metric.resourceType}"`];
  if (metric.messengerFunctions) parts.push('resource.labels.service_name = starts_with("messenger")');
  return parts.join(' AND ');
}

async function queryTimeSeries(metric, interval, authClient) {
  const endpoint = new URL(`https://monitoring.googleapis.com/v3/projects/${PROJECT_ID}/timeSeries`);
  endpoint.searchParams.set('filter', buildMonitoringFilter(metric));
  endpoint.searchParams.set('interval.startTime', interval.startTime);
  endpoint.searchParams.set('interval.endTime', interval.endTime);
  endpoint.searchParams.set('pageSize', '10000');
  if (metric.align) {
    endpoint.searchParams.set('aggregation.alignmentPeriod', '3600s');
    endpoint.searchParams.set('aggregation.perSeriesAligner', 'ALIGN_SUM');
    endpoint.searchParams.set('aggregation.crossSeriesReducer', 'REDUCE_SUM');
  }
  const series = [];
  let pageToken = '';
  let pageCount = 0;
  do {
    if (pageToken) endpoint.searchParams.set('pageToken', pageToken);
    else endpoint.searchParams.delete('pageToken');
    const response = await authClient.request({ url: endpoint.toString(), method: 'GET' });
    series.push(...(response.data && response.data.timeSeries || []));
    pageToken = String(response.data && response.data.nextPageToken || '');
    pageCount += 1;
    if (pageCount > 20) throw new Error('Cloud Monitoring 응답 페이지가 제한을 초과했습니다.');
  } while (pageToken);
  return series;
}

async function collectMonitoringMetrics(interval, logError = () => {}) {
  let client;
  try {
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/monitoring.read'] });
    client = await auth.getClient();
  } catch (error) {
    const code = Number(error && (error.code || error.response && error.response.status)) || null;
    logError('auth', code, error && error.message);
    return Object.fromEntries(Object.keys(MONITORING_METRICS).map((key) => [key, { ok: false, errorCode: code }]));
  }
  const entries = await Promise.all(Object.entries(MONITORING_METRICS).map(async ([key, metric]) => {
    try {
      const series = await queryTimeSeries(metric, interval, client);
      const gaugeSamples = metric.gauge === true ? aggregateDailyGaugeSamples(series) : null;
      const values = gaugeSamples ? new Map([...gaugeSamples].map(([day, sample]) => [day, sample.value])) : aggregateDailyValues(series);
      const sampledAt = gaugeSamples ? Object.fromEntries([...gaugeSamples].map(([day, sample]) => [day, new Date(sample.sampledAt).toISOString()])) : {};
      let latest = null;
      if (metric.gauge) {
        for (const item of values) {
          const [day, value] = item;
          if (!latest || day > latest.day) latest = { day, value };
        }
      }
      return [key, { ok: true, values: Object.fromEntries(values), sampledAt, seriesCount: series.length, latest }];
    } catch (error) {
      const code = Number(error && (error.code || error.response && error.response.status)) || null;
      logError(key, code, error && error.message);
      return [key, { ok: false, errorCode: code }];
    }
  }));
  return Object.fromEntries(entries);
}

async function measureR2Storage(s3) {
  let continuationToken;
  let pages = 0;
  let objects = 0;
  let bytes = 0;
  let truncated = false;
  do {
    const result = await s3.send(new ListObjectsV2Command({
      Bucket: BUCKET,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    }));
    pages += 1;
    for (const item of result.Contents || []) {
      objects += 1;
      bytes += Math.max(0, Number(item.Size) || 0);
    }
    truncated = result.IsTruncated === true;
    continuationToken = truncated ? result.NextContinuationToken : undefined;
  } while (truncated && pages < MAX_R2_LIST_PAGES);
  return {
    bytes,
    objects,
    listRequests: pages,
    complete: !truncated,
    measuredAt: new Date().toISOString(),
  };
}

function mergeMetricValues(rows, metrics, key) {
  const status = metrics[key];
  if (!status || status.ok !== true) return;
  for (const [day, value] of Object.entries(status.values || {})) {
    if (rows.has(day)) {
      rows.get(day)[key] = value;
      if (key === 'rtdbStoredBytes' && status.sampledAt && status.sampledAt[day]) rows.get(day).rtdbStorageSampledAt = status.sampledAt[day];
    }
  }
}

function numericCost(value, rate) {
  return Number.isFinite(value) && value >= 0 ? value * rate : null;
}

function estimateVariableCost(row) {
  const rtdbDownload = numericCost(row.rtdbDownloadedBytes, COST_RATES.rtdbDownloadUsdPerGb / 1e9);
  const requests = numericCost(row.functionRequests, COST_RATES.cloudRunRequestUsdPerMillion / 1e6);
  const cpu = numericCost(row.functionCpuVcpuSeconds, COST_RATES.cloudRunCpuUsdPerVcpuSecond);
  const memory = numericCost(row.functionMemoryGibibyteSeconds, COST_RATES.cloudRunMemoryUsdPerGibibyteSecond);
  const functionCost = requests === null || cpu === null || memory === null ? null : requests + cpu + memory;
  return {
    rtdbDownloadUsd: rtdbDownload,
    cloudRunFunctionsUsd: functionCost,
    trackedVariableUsd: rtdbDownload === null || functionCost === null ? null : rtdbDownload + functionCost,
  };
}

function calculateStorageMonthlyEstimate(rtdbBytes, r2Bytes) {
  const rtdb = numericCost(rtdbBytes, COST_RATES.rtdbStorageUsdPerGbMonth / 1e9);
  const r2 = numericCost(r2Bytes, COST_RATES.r2StorageUsdPerGbMonth / 1e9);
  return {
    rtdbSharedUsdPerMonth: rtdb,
    r2UsdPerMonth: r2,
    trackedUsdPerMonth: rtdb === null || r2 === null ? null : rtdb + r2,
  };
}

async function readSnapshot(s3, encryptionSecret) {
  try {
    const object = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: SNAPSHOT_KEY }));
    const bytes = Buffer.from(await object.Body.transformToByteArray());
    if (bytes.byteLength > MAX_SNAPSHOT_BYTES) throw new Error('사용량 집계 파일이 크기 제한을 초과했습니다.');
    return decryptSnapshot(bytes, encryptionSecret);
  } catch (error) {
    const status = Number(error && (error.$metadata && error.$metadata.httpStatusCode || error.Code && String(error.Code).match(/\d{3}/)?.[0])) || null;
    if (status === 404 || error && ['NoSuchKey', 'NotFound', 'NoSuchBucket'].includes(error.name)) return null;
    throw error;
  }
}

function encryptionKey(secret) {
  return crypto.createHash('sha256').update(`streamer-messenger-usage-v1\0${String(secret)}`).digest();
}

function encryptSnapshot(report, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(report), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from('MUA1'), iv, cipher.getAuthTag(), ciphertext]);
}

function decryptSnapshot(buffer, secret) {
  if (buffer.length < 32 || buffer.toString('ascii', 0, 4) !== 'MUA1') throw new Error('사용량 집계 파일 형식이 올바르지 않습니다.');
  const iv = buffer.subarray(4, 16);
  const tag = buffer.subarray(16, 32);
  const ciphertext = buffer.subarray(32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(secret), iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  const value = JSON.parse(plain);
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.daily)) throw new Error('사용량 집계 파일 버전이 올바르지 않습니다.');
  return value;
}

async function writeSnapshot(s3, report, encryptionSecret) {
  const body = encryptSnapshot(report, encryptionSecret);
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: SNAPSHOT_KEY,
    Body: body,
    ContentType: 'application/octet-stream',
    CacheControl: 'no-store',
    Metadata: { format: 'streamer-messenger-usage-v1-encrypted' },
  }));
  return body.byteLength;
}

async function collectUsageSnapshot(s3, encryptionSecret, { nowMs = Date.now(), logError = () => {} } = {}) {
  const previous = await readSnapshot(s3, encryptionSecret).catch((error) => {
    logError('snapshotRead', Number(error && error.code) || null, error && error.message);
    return null;
  });
  const interval = getCompletedDayRange(nowMs);
  const metricResults = await collectMonitoringMetrics(interval, logError);
  const previousByDay = new Map((previous && previous.daily || []).map((row) => [row.day, row]));
  const rows = new Map();
  for (let offset = 0; offset < HISTORY_DAYS; offset += 1) {
    const day = addDays(interval.from, offset);
    rows.set(day, makeDailyRow(day, previousByDay.get(day)));
  }
  for (const key of Object.keys(MONITORING_METRICS)) mergeMetricValues(rows, metricResults, key);
  const previousStorageHistory = Array.isArray(previous && previous.storageHistory) ? previous.storageHistory : [];
  let r2Storage = null;
  try {
    r2Storage = await measureR2Storage(s3);
  } catch (error) {
    logError('r2Storage', Number(error && error.$metadata && error.$metadata.httpStatusCode) || null, error && error.message);
  }
  const todayR2 = r2Storage ? {
    day: interval.today,
    bytes: r2Storage.bytes,
    objects: r2Storage.objects,
    complete: r2Storage.complete,
    listRequests: r2Storage.listRequests,
    measuredAt: r2Storage.measuredAt,
  } : null;
  const storageHistoryByDay = new Map(previousStorageHistory.map((row) => [row.day, row]));
  if (todayR2) storageHistoryByDay.set(todayR2.day, todayR2);
  const storageHistory = [...storageHistoryByDay.values()]
    .filter((row) => row && /^\d{4}-\d{2}-\d{2}$/.test(row.day) && row.day <= interval.today)
    .sort((a, b) => a.day.localeCompare(b.day))
    .slice(-HISTORY_DAYS);
  const daily = [...rows.values()].map((row) => ({ ...row, estimate: estimateVariableCost(row) }));
  const storageRows = daily.filter((row) => row.rtdbStoredBytes !== null);
  const latestRtdbStorage = storageRows.sort((a, b) => b.day.localeCompare(a.day))[0] || null;
  const r2Latest = todayR2 || previous && previous.current && previous.current.r2 || null;
  const sources = {};
  for (const [key, result] of Object.entries(metricResults)) sources[key] = { available: result.ok, seriesCount: result.seriesCount || 0, errorCode: result.errorCode || null };
  sources.r2Storage = { available: !!todayR2, complete: todayR2 ? todayR2.complete : !!(r2Latest && r2Latest.complete), errorCode: todayR2 ? null : 'unavailable' };
  const current = {
    day: interval.today,
    rtdbStoredBytes: latestRtdbStorage ? latestRtdbStorage.rtdbStoredBytes : previous && previous.current && previous.current.rtdbStoredBytes || null,
    rtdbStorageSampledAt: latestRtdbStorage ? latestRtdbStorage.rtdbStorageSampledAt : previous && previous.current && previous.current.rtdbStorageSampledAt || null,
    r2: r2Latest,
    storageMonthlyEstimate: calculateStorageMonthlyEstimate(
      latestRtdbStorage ? latestRtdbStorage.rtdbStoredBytes : previous && previous.current && previous.current.rtdbStoredBytes,
      r2Latest && r2Latest.bytes,
    ),
  };
  return {
    schemaVersion: 1,
    generatedAt: new Date(nowMs).toISOString(),
    priceEffectiveDate: COST_RATES.effectiveDate,
    historyFrom: interval.from,
    historyThrough: interval.through,
    availableDays: HISTORY_DAYS,
    daily,
    storageHistory,
    current,
    rates: COST_RATES,
    sources,
    limitations: COST_RATES.notes,
  };
}

module.exports = {
  BUCKET,
  COST_RATES,
  HISTORY_DAYS,
  SNAPSHOT_KEY,
  aggregateDailyValues,
  aggregateDailyGaugeSamples,
  addDays,
  calculateStorageMonthlyEstimate,
  collectMonitoringMetrics,
  collectUsageSnapshot,
  decryptSnapshot,
  encryptSnapshot,
  estimateVariableCost,
  getCompletedDayRange,
  kstDayKey,
  readSnapshot,
  writeSnapshot,
};
