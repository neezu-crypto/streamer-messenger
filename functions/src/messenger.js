const crypto = require('crypto');
const dns = require('node:dns').promises;
const https = require('node:https');
const net = require('node:net');
const { gzipSync, gunzipSync } = require('node:zlib');
const { promisify } = require('util');
const { getApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getDatabase, ServerValue } = require('firebase-admin/database');
const { getFunctions } = require('firebase-admin/functions');
const { onCall: firebaseOnCall, HttpsError } = require('firebase-functions/v2/https');
const { onValueWritten } = require('firebase-functions/v2/database');
const { onTaskDispatched: firebaseOnTaskDispatched } = require('firebase-functions/v2/tasks');
const logger = require('firebase-functions/logger');
const { onSchedule: firebaseOnSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { getPrincipal, getVerifiedStreamer, requireAdmin, SERVICE_ID } = require('./auth');
const usageAnalytics = require('./usage-analytics');
const stickerCatalog = require('../catalog/stickers.json');

const scrypt = promisify(crypto.scrypt);
const ROOT = 'streamerMessenger';
const MESSENGER_DATABASE_URL = 'https://streamer-messenger-rtdb.firebaseio.com';
const MAIN_DATABASE_INSTANCE = 'soop-stock-market-default-rtdb';
const MESSENGER_DATABASE_INSTANCE = 'streamer-messenger-rtdb';
const MIGRATION_STATE_PATH = 'messengerDatabaseMigration/state';
const TEST_ROOM_ID = 'messengertestroom';
const MESSAGE_MAX = 1000;
const INTRO_MAX = 500;
const APPLICATION_INTERVAL = 5 * 60 * 1000;
const APPLICATION_EXPIRE = 3 * 24 * 60 * 60 * 1000;
const MESSAGE_COOLDOWN = 2000;
const MESSAGE_LIMIT_PER_MINUTE = 20;
const SPAM_VIOLATION_WINDOW = 10 * 60 * 1000;
const SPAM_VIOLATIONS_BEFORE_COOLDOWN = 3;
const SPAM_COOLDOWNS = [60 * 1000, 10 * 60 * 1000, 60 * 60 * 1000];
const CHAT_RETENTION = 7 * 24 * 60 * 60 * 1000;
const ARCHIVED_MESSAGE_PAGE_SIZE = 20;
const ARCHIVE_WRITE_PAGE_SIZE = 150;
const REPORT_RETENTION = 14 * 24 * 60 * 60 * 1000;
const ROOMSELF_MAX_BYTES = 15 * 1024 * 1024;
const ROOMSELF_UPLOAD_WINDOW = 10 * 1000;
const ROOMSELF_UPLOAD_FINALIZE_TTL = 15 * 60 * 1000;
const ADMIN_REPORT_PAGE_SIZE = 40;
const ADMIN_BAN_PAGE_SIZE = 30;
const ROOMSELF_BUCKET = 'streamer-messenger-private';
const LADDER_PLAYER_LIMIT = 8;
const LADDER_ROW_COUNT = 10;
const LINK_PREVIEW_CACHE_TTL = 10 * 60 * 1000;
const LINK_PREVIEW_CACHE_LIMIT = 40;
const LINK_PREVIEW_HTML_MAX_BYTES = 512 * 1024;
const LINK_PREVIEW_IMAGE_MAX_BYTES = 384 * 1024;
const linkPreviewCache = new Map();
const SOOP_CLIP_CACHE_TTL = 45 * 1000;
const SOOP_CLIP_CACHE_LIMIT = 80;
const soopClipSearchCache = new Map();
const SOOP_LIVE_STATUS_CACHE_TTL = 15 * 1000;
const soopLiveStatusCache = new Map();
const BROADCAST_HISTORY_LIVE_POLL_MS = 5 * 60 * 1000;
const BROADCAST_HISTORY_IDLE_POLL_MS = 10 * 60 * 1000;
const BROADCAST_HISTORY_ERROR_POLL_MS = 5 * 60 * 1000;
const BROADCAST_HISTORY_VOD_RETRY_AFTER_MS = [
  5 * 60 * 1000,
  10 * 60 * 1000,
  30 * 60 * 1000,
  90 * 60 * 1000,
  6 * 60 * 60 * 1000,
  18 * 60 * 60 * 1000,
  36 * 60 * 60 * 1000,
];
const BROADCAST_HISTORY_MAX_CONCURRENCY = 8;
const BROADCAST_HISTORY_TASK_FUNCTION = 'messengerProcessStreamerBroadcastHistory';
const BROADCAST_HISTORY_VIEWER_ANALYSIS_TASK_FUNCTION = 'streamerFanPageMessengerVodAnalysisWorker';
const BROADCAST_HISTORY_VIEWER_ANALYSIS_RETRY_AFTER_MS = [
  30 * 1000,
  2 * 60 * 1000,
  10 * 60 * 1000,
  30 * 60 * 1000,
];
const BROADCAST_HISTORY_TASK_START_DELAY_SECONDS = 5;
const messengerStickerIndex = new Map();
for (const product of stickerCatalog.products || []) {
  for (const sticker of product.preview && Array.isArray(product.preview.stickers) ? product.preview.stickers : []) {
    messengerStickerIndex.set(sticker.id, { id: sticker.id, productId: product.id, freeForAuthenticated: product.freeForAuthenticated === true });
  }
}
const R2_ACCOUNT_ID = '8fe39a69fb377472a64192f9c1b4666e';
const roomselfAccessKeyId = defineSecret('MESSENGER_R2_ACCESS_KEY_ID');
const roomselfSecretAccessKey = defineSecret('MESSENGER_R2_SECRET_ACCESS_KEY');
const USAGE_SNAPSHOT_LOCK_PATH = `${ROOT}/admin/usageAnalyticsSnapshotLock`;

const db = () => getDatabase(getApp(), MESSENGER_DATABASE_URL);
const sharedDb = () => getDatabase(getApp());
let messengerMigrationStateCache = { paused: false, expiresAt: 0 };

async function isMessengerDatabaseMigrationPaused() {
  if (Date.now() < messengerMigrationStateCache.expiresAt) return messengerMigrationStateCache.paused;
  const state = (await sharedDb().ref(MIGRATION_STATE_PATH).get()).val() || {};
  messengerMigrationStateCache = {
    paused: !!state.phase && state.phase !== 'ready',
    expiresAt: Date.now() + 3000,
  };
  return messengerMigrationStateCache.paused;
}

function wrapFunction(factory, kind, args) {
  const callback = args.pop();
  args.push(async (...callbackArgs) => {
    if (await isMessengerDatabaseMigrationPaused()) {
      if (kind === 'call') throw new HttpsError('unavailable', '메신저 데이터베이스 전환 중입니다. 잠시 후 다시 시도해 주세요.');
      if (kind === 'task' || kind === 'trigger') throw new Error('Messenger database migration is paused.');
      return null;
    }
    return callback(...callbackArgs);
  });
  return factory(...args);
}

const onCall = (...args) => wrapFunction(firebaseOnCall, 'call', args);
const onSchedule = (...args) => wrapFunction(firebaseOnSchedule, 'schedule', args);
const onTaskDispatched = (...args) => wrapFunction(firebaseOnTaskDispatched, 'task', args);
const now = () => Date.now();
function principalRoomId(principal) {
  if (principal.streamer && /^[a-z0-9]{2,30}$/.test(principal.streamer.soopId || '')) return principal.streamer.soopId;
  if (principal.admin) return `admin${crypto.createHash('sha256').update(principal.uid).digest('hex').slice(0, 24)}`;
  return '';
}
const safeText = (value, max, required = false) => {
  if (typeof value !== 'string') throw new HttpsError('invalid-argument', '입력값이 올바르지 않습니다.');
  const text = value.trim();
  if ((required && !text) || text.length > max || /[<>\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(text)) {
    throw new HttpsError('invalid-argument', '입력 내용을 확인해 주세요.');
  }
  return text;
};

function isPublicIpv4(address) {
  if (net.isIP(address) !== 4) return false;
  const octets = address.split('.').map(Number);
  const [a, b, c] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && ((b === 0 && (c === 0 || c === 2)) || b === 168)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function safePreviewUrl(value, base) {
  let url;
  try { url = base ? new URL(value, base) : new URL(value); } catch (_) { return null; }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
    || !hostname || net.isIP(hostname.replace(/^\[|\]$/g, ''))
    || hostname.includes(':') || hostname === 'localhost' || hostname.endsWith('.localhost')
    || hostname.endsWith('.local') || hostname.endsWith('.internal') || url.href.length > 2048) return null;
  url.hash = '';
  return url;
}

async function requestPublicHttps(url, maxBytes) {
  const records = await dns.lookup(url.hostname, { family: 4, all: true, verbatim: true });
  if (!records.length || records.some((record) => !isPublicIpv4(record.address))) throw new Error('외부 공개 주소가 아닙니다.');
  const address = records[0].address;
  return new Promise((resolve, reject) => {
    const request = https.request({
      protocol: 'https:', hostname: url.hostname, servername: url.hostname, port: 443,
      path: `${url.pathname || '/'}${url.search}`, method: 'GET',
      headers: { 'User-Agent': 'StreamerMessengerLinkPreview/1.0', Accept: 'text/html,image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1', 'Accept-Encoding': 'identity' },
      lookup: (_hostname, _options, callback) => callback(null, address, 4),
    }, (response) => {
      const chunks = []; let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) { response.destroy(new Error('미리보기 응답 크기가 제한을 초과했습니다.')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({ status: response.statusCode || 0, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    request.setTimeout(4500, () => request.destroy(new Error('미리보기 요청 시간이 초과되었습니다.')));
    request.on('error', reject);
    request.end();
  });
}

async function fetchPreviewResource(initialUrl, maxRedirects, maxBytes, acceptedType) {
  let url = initialUrl;
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const response = await requestPublicHttps(url, maxBytes);
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
      if (redirects === maxRedirects) throw new Error('미리보기 리디렉션 횟수를 초과했습니다.');
      url = safePreviewUrl(response.headers.location, url);
      if (!url) throw new Error('안전하지 않은 미리보기 주소입니다.');
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error('미리보기 응답을 가져오지 못했습니다.');
    const contentType = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!acceptedType(contentType)) throw new Error('지원하지 않는 미리보기 형식입니다.');
    return { url, contentType, body: response.body };
  }
  throw new Error('미리보기 주소를 확인할 수 없습니다.');
}

function decodeHtmlEntities(value) {
  return String(value || '').replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (match, entity) => {
    const key = entity.toLowerCase();
    if (key[0] === '#') {
      const code = key[1] === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return ({ amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' })[key] || match;
  });
}

function htmlMetadata(html) {
  const meta = new Map();
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  for (const tag of tags) {
    const attrs = {};
    tag.replace(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g, (_match, key, doubleQuoted, singleQuoted, bare) => {
      attrs[key.toLowerCase()] = decodeHtmlEntities(doubleQuoted ?? singleQuoted ?? bare ?? '');
      return '';
    });
    const key = String(attrs.property || attrs.name || '').toLowerCase();
    if (key && attrs.content && !meta.has(key)) meta.set(key, attrs.content);
  }
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i);
  const clean = (value, max) => decodeHtmlEntities(String(value || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, max);
  return {
    title: clean(meta.get('og:title') || meta.get('twitter:title') || (titleMatch && titleMatch[1]), 180),
    description: clean(meta.get('og:description') || meta.get('description') || meta.get('twitter:description'), 320),
    image: meta.get('og:image:secure_url') || meta.get('og:image') || meta.get('twitter:image') || '',
  };
}

async function getLinkPreview(rawUrl) {
  const url = safePreviewUrl(rawUrl);
  if (!url) throw new HttpsError('invalid-argument', 'HTTPS 링크만 미리보기를 표시할 수 있습니다.');
  const key = url.href;
  const cached = linkPreviewCache.get(key);
  if (cached && cached.expiresAt > now()) return cached.value;
  try {
    const page = await fetchPreviewResource(url, 3, LINK_PREVIEW_HTML_MAX_BYTES, (type) => type === 'text/html' || type === 'application/xhtml+xml');
    const metadata = htmlMetadata(page.body.toString('utf8'));
    let image = null;
    if (metadata.image) {
      const imageUrl = safePreviewUrl(metadata.image, page.url);
      if (imageUrl) {
        try {
          const resource = await fetchPreviewResource(imageUrl, 2, LINK_PREVIEW_IMAGE_MAX_BYTES, (type) => ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif'].includes(type));
          image = { contentType: resource.contentType, data: resource.body.toString('base64') };
        } catch (_) { /* 텍스트 카드만 표시 */ }
      }
    }
    const value = { url: page.url.href, title: metadata.title || page.url.hostname, description: metadata.description, image };
    linkPreviewCache.set(key, { expiresAt: now() + LINK_PREVIEW_CACHE_TTL, value });
    while (linkPreviewCache.size > LINK_PREVIEW_CACHE_LIMIT) linkPreviewCache.delete(linkPreviewCache.keys().next().value);
    return value;
  } catch (error) {
    const value = { url: key, title: new URL(key).hostname, description: '', image: null };
    linkPreviewCache.set(key, { expiresAt: now() + 60 * 1000, value });
    while (linkPreviewCache.size > LINK_PREVIEW_CACHE_LIMIT) linkPreviewCache.delete(linkPreviewCache.keys().next().value);
    return value;
  }
}
const roomRef = (roomId) => db().ref(`${ROOT}/rooms/${roomId}`);
const userRoomIndexPath = (uid, roomId) => `${ROOT}/userRoomIndex/${uid}/${roomId}`;
const testAccountsRef = () => db().ref(`${ROOT}/admin/testAccounts`);
const testAccountRef = (uid) => testAccountsRef().child(uid);
const roomselfS3 = () => new S3Client({ region: 'auto', endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, credentials: { accessKeyId: roomselfAccessKeyId.value(), secretAccessKey: roomselfSecretAccessKey.value() } });
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const roomselfKey = (id, ext) => `roomself/${id.slice(0, 2)}/${id}.${ext}`;
const roomselfDateShard = (time) => new Date(time).toISOString().slice(0, 10).replaceAll('-', '');
const archiveDateShard = (time) => new Date(Number(time) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10).replaceAll('-', '');
const archiveRoomToken = (roomId, generation) => crypto.createHash('sha256').update(`${roomId}\0${generation}`).digest('hex').slice(0, 24);
const archivePrivateScope = (uid) => `private_${crypto.createHash('sha256').update(String(uid)).digest('hex').slice(0, 24)}`;
const archiveMessageScopeUid = (message) => message && message.senderRole === 'fan' ? String(message.senderUid || '') : String(message && message.recipientUid || '');
const compareMessagePosition = (a, b) => Number(a && a.createdAt || 0) - Number(b && b.createdAt || 0) || (String(a && a.id || '') < String(b && b.id || '') ? -1 : String(a && a.id || '') > String(b && b.id || '') ? 1 : 0);
const compareArchiveTuple = (createdAtA, idA, createdAtB, idB) => Number(createdAtA || 0) - Number(createdAtB || 0) || (String(idA || '') < String(idB || '') ? -1 : String(idA || '') > String(idB || '') ? 1 : 0);
function roomselfBytesMatchType(bytes, contentType) {
  if (contentType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === 'image/png') return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (contentType === 'image/webp') return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (contentType === 'image/gif') return ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6));
  return false;
}

function messageArchiveIndexPath(roomId, generation, scopeKey) {
  return `${ROOT}/messageArchiveIndex/${roomId}/${generation}/${scopeKey}`;
}

function archivedRoomselfImagesPath(roomId, generation) {
  return `${ROOT}/archivedRoomselfImages/${roomId}/${generation}`;
}

async function ensureMessageArchiveGeneration(roomId) {
  const generationRef = roomRef(roomId).child('meta/archiveGeneration');
  const result = await generationRef.transaction((current) => /^[a-f0-9]{32}$/.test(String(current || '')) ? current : crypto.randomBytes(16).toString('hex'));
  return String(result.snapshot.val() || '');
}

async function deleteR2Prefix(s3, prefix) {
  let continuationToken = undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: ROOMSELF_BUCKET, Prefix: prefix, ContinuationToken: continuationToken }));
    const keys = (page.Contents || []).map((item) => item && item.Key).filter(Boolean);
    for (let offset = 0; offset < keys.length; offset += 1000) {
      const result = await s3.send(new DeleteObjectsCommand({ Bucket: ROOMSELF_BUCKET, Delete: { Objects: keys.slice(offset, offset + 1000).map((Key) => ({ Key })), Quiet: true } }));
      if (result.Errors && result.Errors.length) throw new Error(`R2 보관 파일 ${result.Errors.length}개를 정리하지 못했습니다.`);
    }
    continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (continuationToken);
}

async function listLiveRoomselfImageIds(roomId) {
  const timelineRef = db().ref(`${ROOT}/chat/${roomId}/streamerTimeline`);
  const imageIds = new Set();
  let cursor = null;
  while (true) {
    let query = timelineRef.orderByChild('createdAt');
    if (cursor) query = query.startAfter(cursor.createdAt, cursor.key);
    const page = await query.limitToFirst(400).get();
    if (!page.exists()) break;
    let last = null;
    page.forEach((child) => {
      const message = child.val() || {};
      last = { createdAt: Number(message.createdAt) || 0, key: child.key };
      if (message.kind === 'roomself' && message.roomselfImageId) imageIds.add(String(message.roomselfImageId));
    });
    cursor = last;
    if (page.numChildren() < 400 || !cursor) break;
  }
  return imageIds;
}

async function cleanMessageArchiveQueue(s3) {
  const queueSnap = await db().ref(`${ROOT}/messageArchiveCleanup`).get();
  const jobs = queueSnap.val() || {};
  for (const [jobId, job] of Object.entries(jobs)) {
    const roomId = String(job && job.roomId || '');
    const generation = String(job && job.generation || '');
    if (!/^[a-z0-9]{2,30}$/.test(roomId) || !/^[a-f0-9]{32}$/.test(generation)) continue;
    const prefix = `message-archives/${archiveRoomToken(roomId, generation)}/`;
    await deleteR2Prefix(s3, prefix);
    const imageIndexPath = archivedRoomselfImagesPath(roomId, generation);
    const imageIndexRef = db().ref(imageIndexPath);
    while (true) {
      const imagePage = await imageIndexRef.orderByKey().limitToFirst(100).get();
      if (!imagePage.exists()) break;
      const imageIds = [];
      imagePage.forEach((child) => { if (child.key) imageIds.push(child.key); });
      for (const imageId of imageIds) {
        const [imageSnap, refsSnap] = await Promise.all([
          db().ref(`${ROOT}/privateImages/${imageId}`).get(),
          db().ref(`${ROOT}/privateImageRefs/${imageId}`).get(),
        ]);
        const image = imageSnap.val() || {};
        const refs = refsSnap.val() || {};
        if (image.roomId === roomId) {
          const retained = Object.values(refs).some((until) => Number(until) >= now());
          if (retained) {
            await db().ref(`${ROOT}/privateImages/${imageId}/archived`).remove();
          } else {
            if (image.key && image.key.startsWith('roomself/')) await s3.send(new DeleteObjectCommand({ Bucket: ROOMSELF_BUCKET, Key: image.key }));
            const imageDay = roomselfDateShard(image.createdAt);
            await db().ref().update({
              [`${ROOT}/privateImages/${imageId}`]: null,
              [`${ROOT}/privateImageRefs/${imageId}`]: null,
              [`${ROOT}/privateImageDays/${imageDay}/${imageId}`]: null,
            });
          }
        }
        await imageIndexRef.child(imageId).remove();
      }
    }
    await db().ref().update({ [`${ROOT}/messageArchiveIndex/${roomId}/${generation}`]: null });
    const currentGenerationRef = roomRef(roomId).child('meta/archiveGeneration');
    if ((await currentGenerationRef.get()).val() === generation) await currentGenerationRef.remove();
    await db().ref(`${ROOT}/messageArchiveCleanup/${jobId}`).remove();
  }
}

function previousArchiveDateShard(day) {
  const value = String(day || '');
  if (!/^\d{8}$/.test(value)) return '';
  const date = new Date(Date.UTC(Number(value.slice(0, 4)), Number(value.slice(4, 6)) - 1, Number(value.slice(6, 8)) - 1));
  return date.toISOString().slice(0, 10).replaceAll('-', '');
}

async function archiveExpiredMessagePage(roomId, generation, entries, s3) {
  const byDay = new Map();
  for (const entry of entries) {
    const message = { ...(entry.message || {}), id: String(entry.id || entry.message && entry.message.id || '') };
    const day = archiveDateShard(message.createdAt);
    if (!day || !message.id) throw new Error(`대화 보관 데이터의 날짜 또는 ID가 올바르지 않습니다: ${roomId}`);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(message);
  }

  const indexUpdates = {};
  for (const [day, messages] of byDay) {
    messages.sort(compareMessagePosition);
    const chunkId = crypto.createHash('sha256').update(`${roomId}\0${messages.map((message) => message.id).join('\0')}`).digest('hex').slice(0, 40);
    const key = `message-archives/${archiveRoomToken(roomId, generation)}/${day}/${chunkId}.json.gz`;
    const payload = Buffer.from(JSON.stringify({ version: 1, roomId, messages }));
    await s3.send(new PutObjectCommand({
      Bucket: ROOMSELF_BUCKET,
      Key: key,
      Body: gzipSync(payload),
      ContentType: 'application/json',
      ContentEncoding: 'gzip',
    }));

    const addScopeIndex = (scopeKey, scopeMessages) => {
      if (!scopeMessages.length) return;
      const ordered = scopeMessages.slice().sort(compareMessagePosition);
      indexUpdates[`${messageArchiveIndexPath(roomId, generation, scopeKey)}/${day}/${chunkId}`] = {
        key,
        count: ordered.length,
        minCreatedAt: Number(ordered[0].createdAt) || 0,
        minId: ordered[0].id,
        maxCreatedAt: Number(ordered[ordered.length - 1].createdAt) || 0,
        maxId: ordered[ordered.length - 1].id,
      };
    };

    addScopeIndex('owner', messages);
    addScopeIndex('broadcast', messages.filter((message) => message.scope === 'broadcast'));
    const privateByUid = new Map();
    for (const message of messages) {
      const uid = archiveMessageScopeUid(message);
      if (uid) {
        if (!privateByUid.has(uid)) privateByUid.set(uid, []);
        privateByUid.get(uid).push(message);
      }
    }
    for (const [uid, privateMessages] of privateByUid) addScopeIndex(archivePrivateScope(uid), privateMessages);
  }
  return { indexUpdates };
}

function expiredMessageLivePathUpdates(roomId, entries) {
  const updates = {};
  for (const { id, message } of entries) {
    updates[`${ROOT}/chat/${roomId}/streamerTimeline/${id}`] = null;
    updates[`${ROOT}/chat/${roomId}/broadcast/${id}`] = null;
    const privateUid = archiveMessageScopeUid(message);
    if (privateUid) updates[`${ROOT}/chat/${roomId}/private/${privateUid}/${id}`] = null;
  }
  return updates;
}

async function readMessageArchiveObject(s3, key, roomId) {
  const object = await s3.send(new GetObjectCommand({ Bucket: ROOMSELF_BUCKET, Key: key }));
  const compressed = Buffer.from(await object.Body.transformToByteArray());
  if (compressed.byteLength > 5 * 1024 * 1024) throw new Error('대화 보관 파일 크기 제한을 초과했습니다.');
  const payload = JSON.parse(gunzipSync(compressed).toString('utf8'));
  if (!payload || payload.version !== 1 || payload.roomId !== roomId || !Array.isArray(payload.messages)) throw new Error('대화 보관 파일 형식이 올바르지 않습니다.');
  return payload.messages;
}

async function loadArchivedMessagePage(roomId, generation, scopeKey, uid, rawCursor, s3, objectCache, pageSize = ARCHIVED_MESSAGE_PAGE_SIZE) {
  const limit = Math.max(1, Math.min(ARCHIVED_MESSAGE_PAGE_SIZE, Number(pageSize) || ARCHIVED_MESSAGE_PAGE_SIZE));
  let cursor = null;
  if (rawCursor !== null && rawCursor !== undefined) {
    const id = String(rawCursor.id || '');
    const createdAt = Number(rawCursor.createdAt);
    if (!/^[A-Za-z0-9_-]{20}$/.test(id) || !Number.isFinite(createdAt) || createdAt < 0) {
      throw new HttpsError('invalid-argument', '이전 대화 위치가 올바르지 않습니다.');
    }
    cursor = { id, createdAt };
  } else {
    cursor = { id: '\uffff', createdAt: now() + 1 };
  }

  let upperDay = archiveDateShard(cursor.createdAt);
  const selectedById = new Map();
  const indexRef = db().ref(messageArchiveIndexPath(roomId, generation, scopeKey));
  while (upperDay) {
    const daySnap = await indexRef.orderByKey().endAt(upperDay).limitToLast(1).get();
    if (!daySnap.exists()) break;
    let day = '';
    let chunks = {};
    daySnap.forEach((child) => { day = child.key; chunks = child.val() || {}; });
    const candidates = Object.values(chunks).filter((chunk) => chunk && typeof chunk.key === 'string'
      && compareArchiveTuple(chunk.minCreatedAt, chunk.minId, cursor.createdAt, cursor.id) < 0)
      .sort((a, b) => compareArchiveTuple(b.maxCreatedAt, b.maxId, a.maxCreatedAt, a.maxId));

    for (const chunk of candidates) {
      const currentPage = [...selectedById.values()].sort((a, b) => compareMessagePosition(b, a));
      if (currentPage.length > limit
        && compareArchiveTuple(chunk.maxCreatedAt, chunk.maxId, currentPage[limit].createdAt, currentPage[limit].id) <= 0) break;
      let messages = objectCache.get(chunk.key);
      if (!messages) {
        messages = readMessageArchiveObject(s3, chunk.key, roomId);
        objectCache.set(chunk.key, messages);
      }
      for (const message of await messages) {
        if (!message || compareMessagePosition(message, cursor) >= 0) continue;
        if (scopeKey === 'broadcast' && message.scope !== 'broadcast') continue;
        if (scopeKey.startsWith('private_') && archiveMessageScopeUid(message) !== uid) continue;
        selectedById.set(String(message.id || ''), message);
      }
    }

    const page = [...selectedById.values()].sort(compareMessagePosition);
    if (page.length > limit) {
      return { messages: page.slice(-limit), hasMore: true };
    }
    upperDay = previousArchiveDateShard(day);
  }
  return { messages: [...selectedById.values()].sort(compareMessagePosition), hasMore: false };
}

async function profileFor(uid) {
  const snap = await sharedDb().ref(`gallery/profiles/${uid}`).get();
  const p = snap.val() || {};
  return { nickname: String(p.nickname || '').slice(0, 30), soopId: String(p.soopId || '').slice(0, 30), avatarUrl: String(p.avatarUrl || '').slice(0, 500) };
}

async function assertProfile(uid) {
  const profile = await profileFor(uid);
  if (!profile.nickname || !profile.soopId) throw new HttpsError('failed-precondition', '채팅 신청 전에 프로필 사진, SOOP 닉네임, SOOP 아이디를 설정해 주세요.');
  return profile;
}

async function requireRoomMember(principal, roomId) {
  const [metaSnap, memberSnap] = await Promise.all([
    roomRef(roomId).child('meta').get(),
    roomRef(roomId).child(`members/${principal.uid}`).get(),
  ]);
  if (!metaSnap.exists()) throw new HttpsError('not-found', '채팅방을 찾을 수 없습니다.');
  const meta = metaSnap.val() || {};
  const isOwner = meta.ownerUid === principal.uid;
  if (!isOwner && (!memberSnap.exists() || memberSnap.val().status !== 'active')) {
    throw new HttpsError('permission-denied', '채팅방 참여 권한이 없습니다.');
  }
  return { meta, isOwner, member: memberSnap.val() || null };
}

async function requireRoomSendAccess(request, roomId) {
  const id = String(roomId || '');
  if (!/^[a-z0-9]{2,30}$/.test(id)) throw new HttpsError('invalid-argument', '채팅방 정보가 올바르지 않습니다.');
  const uid = request.auth && request.auth.uid;
  if (!uid) return getPrincipal(request);
  const memberRef = roomRef(id).child(`members/${uid}`);
  const accountPromise = request.auth.token && request.auth.token.messengerTestAccount === true
    ? testAccountRef(uid).get()
    : Promise.resolve(null);
  const [principal, metaSnap, memberSnap, accountSnap] = await Promise.all([
    getPrincipal(request),
    roomRef(id).child('meta').get(),
    memberRef.get(),
    accountPromise,
  ]);
  if (!metaSnap.exists()) throw new HttpsError('not-found', '채팅방을 찾을 수 없습니다.');
  const meta = metaSnap.val() || {};
  const isOwner = meta.ownerUid === principal.uid;
  const member = memberSnap.val() || null;
  if (id === TEST_ROOM_ID || meta.roomType === 'test') {
    if (id !== TEST_ROOM_ID || meta.roomType !== 'test') throw new HttpsError('permission-denied', '테스트방에 접근할 수 없습니다.');
    if (principal.testAccount) {
      const account = accountSnap && accountSnap.val() || {};
      if (account.active !== true) throw new HttpsError('permission-denied', '비활성화된 테스트 계정입니다.');
    } else if (!principal.admin) {
      throw new HttpsError('permission-denied', '테스트방은 관리자와 등록된 테스트 계정만 이용할 수 있습니다.');
    }
    if (!isOwner && (!member || member.status !== 'active')) {
      throw new HttpsError('permission-denied', '테스트방 참여 권한이 없습니다.');
    }
    return { principal, roomAccess: { meta, isOwner, member } };
  }
  if (principal.testAccount) throw new HttpsError('permission-denied', '테스트 계정은 테스트방에서만 이용할 수 없습니다.');
  if (!principal.trusted) throw new HttpsError('permission-denied', 'Google/카카오 로그인 또는 스트리머 인증 후 이용해 주세요.');
  if (!isOwner && (!member || member.status !== 'active')) {
    throw new HttpsError('permission-denied', '채팅방 참여 권한이 없습니다.');
  }
  return { principal, roomAccess: { meta, isOwner, member } };
}

async function requireRoomPrincipal(request, roomId) {
  const id = String(roomId || '');
  if (!/^[a-z0-9]{2,30}$/.test(id)) throw new HttpsError('invalid-argument', '채팅방 정보가 올바르지 않습니다.');
  const principal = await getPrincipal(request);
  const metaSnap = await roomRef(id).child('meta').get();
  if (!metaSnap.exists()) throw new HttpsError('not-found', '채팅방을 찾을 수 없습니다.');
  const meta = metaSnap.val() || {};
  if (id === TEST_ROOM_ID || meta.roomType === 'test') {
    if (id !== TEST_ROOM_ID || meta.roomType !== 'test') throw new HttpsError('permission-denied', '테스트방에 접근할 수 없습니다.');
    if (principal.testAccount) {
      const account = (await testAccountRef(principal.uid).get()).val() || {};
      if (account.active !== true) throw new HttpsError('permission-denied', '비활성화된 테스트 계정입니다.');
    } else if (!principal.admin) {
      throw new HttpsError('permission-denied', '테스트방은 관리자와 등록된 테스트 계정만 이용할 수 있습니다.');
    }
    const member = (await roomRef(id).child(`members/${principal.uid}`).get()).val() || {};
    if (meta.ownerUid !== principal.uid && member.status !== 'active') {
      throw new HttpsError('permission-denied', '테스트방 참여 권한이 없습니다.');
    }
    return principal;
  }
  if (principal.testAccount) throw new HttpsError('permission-denied', '테스트 계정은 테스트방에서만 이용할 수 없습니다.');
  if (!principal.trusted) throw new HttpsError('permission-denied', 'Google/카카오 로그인 또는 스트리머 인증 후 이용해 주세요.');
  return principal;
}

async function addTestRoomMember(uid, profile, role, roomMeta) {
  const at = now();
  const memberRef = roomRef(TEST_ROOM_ID).child(`members/${uid}`);
  const member = {
    uid,
    status: 'active',
    joinedAt: at,
    profile: {
      nickname: String(profile && profile.nickname || (role === 'host' ? '테스트 진행자' : '테스트 참여자')).slice(0, 30),
      soopId: String(profile && profile.soopId || '').slice(0, 30),
      avatarUrl: String(profile && profile.avatarUrl || '').slice(0, 500),
    },
    testAccount: role !== 'admin',
  };
  const existing = await memberRef.get();
  if (!existing.exists() || existing.val().status !== 'active') {
    await memberRef.set(member);
    await roomRef(TEST_ROOM_ID).child('meta/memberCount').transaction((count) => (Number(count) || 0) + 1);
  }
  await db().ref(userRoomIndexPath(uid, TEST_ROOM_ID)).set({ joinedAt: Number((await memberRef.child('joinedAt').get()).val()) || at });
  return { member, room: publicRoom(roomMeta, uid === roomMeta.ownerUid) };
}

async function writeAudit(uid, action, detail) {
  const ref = db().ref(`${ROOT}/auditLog`).push();
  await ref.set({ actorUid: uid, action, detail: String(detail || '').slice(0, 240), at: now() });
  const old = await db().ref(`${ROOT}/auditLog`).orderByKey().get();
  const keys = Object.keys(old.val() || {});
  if (keys.length > 200) {
    const updates = {};
    keys.slice(0, keys.length - 200).forEach((key) => { updates[key] = null; });
    await db().ref(`${ROOT}/auditLog`).update(updates);
  }
}

async function ensureMessengerBanIndex() {
  const adminRef = db().ref(`${ROOT}/admin`);
  const versionSnap = await adminRef.child('banIndexVersion').get();
  if (Number(versionSnap.val()) >= 1) return;
  const stateRef = adminRef.child('banIndexBackfill');
  const lock = await stateRef.transaction((value) => {
    const state = value || {};
    if (Number(state.version) >= 1 || (state.status === 'running' && now() - Number(state.startedAt || 0) < 10 * 60 * 1000)) return;
    return { status: 'running', startedAt: now() };
  }, undefined, false);
  if (!lock.committed) {
    const deadline = now() + 10000;
    while (now() < deadline) {
      const state = (await stateRef.get()).val() || {};
      if (Number(state.version) >= 1) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new HttpsError('unavailable', '정지 계정 목록을 준비하고 있습니다. 잠시 후 다시 열어 주세요.');
  }

  try {
    // One-time, key-paged backfill from the shared ban tree. Dashboard reads
    // after this use only the service-scoped index and counter.
    await adminRef.child('banIndex').set(null);
    const source = sharedDb().ref('bannedAccounts').orderByKey();
    let cursor = null;
    let count = 0;
    while (true) {
      let query = source;
      if (cursor) query = query.startAfter(cursor);
      const page = await query.limitToFirst(400).get();
      if (!page.exists()) break;
      const updates = {};
      let lastKey = null;
      page.forEach((child) => {
        lastKey = child.key;
        const ban = child.child(`games/${SERVICE_ID}`).val();
        if (ban) {
          updates[`${ROOT}/admin/banIndex/${child.key}`] = ban;
          count += 1;
        }
      });
      if (Object.keys(updates).length) await db().ref().update(updates);
      if (page.numChildren() < 400 || !lastKey) break;
      cursor = lastKey;
    }
    await adminRef.update({ activeBanCount: count, banIndexVersion: 1 });
    await stateRef.set({ version: 1, status: 'complete', startedAt: Number(lock.snapshot.val().startedAt) || now(), completedAt: now(), indexedBans: count });
  } catch (error) {
    await stateRef.set({ version: 0, status: 'failed', failedAt: now(), errorCode: String(error && error.code || 'unknown').slice(0, 80) });
    throw error;
  }
}

async function ensureReportStatuses() {
  const stateRef = db().ref(`${ROOT}/admin/reportStatusBackfill`);
  const current = (await stateRef.get()).val() || {};
  if (Number(current.version) >= 1) return;

  const lock = await stateRef.transaction((value) => {
    const state = value || {};
    if (Number(state.version) >= 1 || (state.status === 'running' && now() - Number(state.startedAt || 0) < 10 * 60 * 1000)) return;
    return { status: 'running', startedAt: now() };
  }, undefined, false);
  if (!lock.committed) {
    const deadline = now() + 10000;
    while (now() < deadline) {
      const state = (await stateRef.get()).val() || {};
      if (Number(state.version) >= 1) return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new HttpsError('unavailable', '신고 목록을 준비하고 있습니다. 잠시 후 다시 열어 주세요.');
  }

  try {
    const source = db().ref(`${ROOT}/reports`).orderByKey();
    let cursor = null;
    let migratedReports = 0;
    while (true) {
      let query = source;
      if (cursor) query = query.startAfter(cursor);
      const page = await query.limitToFirst(400).get();
      if (!page.exists()) break;
      const updates = {};
      let lastKey = null;
      page.forEach((child) => {
        lastKey = child.key;
        const report = child.val() || {};
        if (!report.status) {
          updates[`${ROOT}/reports/${child.key}/status`] = 'pending';
          migratedReports += 1;
        }
      });
      if (Object.keys(updates).length) await db().ref().update(updates);
      if (page.numChildren() < 400 || !lastKey) break;
      cursor = lastKey;
    }
    await stateRef.set({ version: 1, status: 'complete', startedAt: Number(lock.snapshot.val().startedAt) || now(), completedAt: now(), migratedReports });
  } catch (error) {
    await stateRef.set({ version: 0, status: 'failed', failedAt: now(), errorCode: String(error && error.code || 'unknown').slice(0, 80) });
    throw error;
  }
}

async function getAdminReportPage(status, cursor, pageSize = ADMIN_REPORT_PAGE_SIZE) {
  const reportsRef = db().ref(`${ROOT}/reports`);
  let query;
  if (status === 'all') {
    query = reportsRef.orderByChild('createdAt');
    if (cursor) query = query.endBefore(Number(cursor.createdAt), String(cursor.id));
  } else {
    query = reportsRef.orderByChild('status').startAt(status);
    query = cursor ? query.endBefore(status, String(cursor.id)) : query.endAt(status);
  }
  const snap = await query.limitToLast(pageSize + 1).get();
  const rows = [];
  snap.forEach((child) => rows.push({ ...(child.val() || {}), id: child.key }));
  const hasMore = rows.length > pageSize;
  if (hasMore) rows.shift();
  rows.reverse();
  const oldest = rows[rows.length - 1];
  return {
    reports: rows,
    hasMore,
    nextCursor: hasMore && oldest ? { id: oldest.id, createdAt: Number(oldest.createdAt) || 0 } : null,
  };
}

async function getAdminBanPage(cursor, pageSize = ADMIN_BAN_PAGE_SIZE) {
  const bansRef = db().ref(`${ROOT}/admin/banIndex`).orderByKey();
  const query = cursor ? bansRef.endBefore(String(cursor)) : bansRef;
  const snap = await query.limitToLast(pageSize + 1).get();
  const rows = [];
  snap.forEach((child) => rows.push({ ...(child.val() || {}), uid: child.key }));
  const hasMore = rows.length > pageSize;
  if (hasMore) rows.shift();
  rows.reverse();
  return {
    bans: rows,
    hasMore,
    nextCursor: hasMore && rows.length ? rows[rows.length - 1].uid : null,
  };
}

async function passwordDigest(password, salt) {
  return (await scrypt(password, salt, 32)).toString('hex');
}

function generateRoomPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(12), (byte) => alphabet[byte & 31]).join('');
}

async function assertRoomPassword(meta, password) {
  if (meta.visibility !== 'private') return;
  if (!meta.passwordSalt || !meta.passwordHash || typeof password !== 'string') throw new HttpsError('permission-denied', '비공개방 비밀번호를 입력해 주세요.');
  const digest = await passwordDigest(password, meta.passwordSalt);
  const a = Buffer.from(digest, 'hex'); const b = Buffer.from(meta.passwordHash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpsError('permission-denied', '비밀번호가 맞지 않습니다.');
}

async function applyCooldown(uid, roomId) {
  const ref = db().ref(`${ROOT}/rateLimits/applications/${uid}/${roomId}`);
  const result = await ref.transaction((last) => {
    const t = now();
    if (last && t - last < APPLICATION_INTERVAL) return;
    return t;
  });
  if (!result.committed) throw new HttpsError('resource-exhausted', '대화 신청은 5분에 한 번만 보낼 수 있습니다.');
}

function cooldownError(until) {
  const seconds = Math.max(1, Math.ceil((Number(until) - now()) / 1000));
  return new HttpsError('resource-exhausted', `스팸 방지 제한이 적용되었습니다. ${seconds}초 후 다시 시도해 주세요.`);
}

async function recordMessageViolation(uid, message) {
  const ref = db().ref(`${ROOT}/rateLimits/messages/${uid}/moderation`);
  const t = now();
  const result = await ref.transaction((currentValue) => {
    const current = currentValue || {};
    if (Number(current.cooldownUntil) > t) return;
    const expired = t - Number(current.lastViolationAt || 0) > 24 * 60 * 60 * 1000;
    const sameWindow = !expired && t - Number(current.violationWindowAt || 0) <= SPAM_VIOLATION_WINDOW;
    const violations = (sameWindow ? Number(current.violations) || 0 : 0) + 1;
    const level = expired ? 0 : Math.min(2, Number(current.cooldownLevel) || 0);
    const next = {
      ...current,
      violations,
      violationWindowAt: sameWindow ? Number(current.violationWindowAt) : t,
      lastViolationAt: t,
    };
    if (violations >= SPAM_VIOLATIONS_BEFORE_COOLDOWN) {
      next.cooldownUntil = t + SPAM_COOLDOWNS[level];
      next.cooldownLevel = Math.min(level + 1, SPAM_COOLDOWNS.length - 1);
      next.violations = 0;
      next.violationWindowAt = t;
    }
    return next;
  });
  const latest = result.snapshot.val() || {};
  if (Number(latest.cooldownUntil) > now()) throw cooldownError(latest.cooldownUntil);
  throw new HttpsError('resource-exhausted', message);
}

async function checkRepeatedMessage(uid, roomId, text, repeatTextDelaySeconds, repeatLinkDelaySeconds) {
  const normalized = String(text || '').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
  if (!normalized) return;
  const t = now();
  if (repeatTextDelaySeconds > 0) {
    const hash = crypto.createHash('sha256').update(normalized).digest('hex');
    const ref = db().ref(`${ROOT}/rateLimits/rooms/${roomId}/${uid}/recentText`);
    const result = await ref.transaction((current) => {
      if (current && current.hash === hash && t - Number(current.at || 0) < repeatTextDelaySeconds * 1000) return;
      return { hash, at: t };
    });
    if (!result.committed) await recordMessageViolation(uid, '같은 메시지를 반복해서 보낼 수 없습니다.');
  }

  if (repeatLinkDelaySeconds <= 0) return;
  const links = normalized.match(/https?:\/\/[^\s<>()]+/g) || [];
  const url = links.length ? links[0].replace(/[.,!?;:]+$/, '') : '';
  if (!url) return;
  const urlRef = db().ref(`${ROOT}/rateLimits/rooms/${roomId}/${uid}/recentLink`);
  const linkHash = crypto.createHash('sha256').update(url).digest('hex');
  const linkResult = await urlRef.transaction((current) => {
    if (current && current.hash === linkHash && t - Number(current.at || 0) < repeatLinkDelaySeconds * 1000) return;
    return { hash: linkHash, at: t };
  });
  if (!linkResult.committed) await recordMessageViolation(uid, '같은 링크를 반복해서 보낼 수 없습니다.');
}

async function applyMessageRate(uid, roomId, text, meta, isOwner = false) {
  let staleRateBucketCleanup = Promise.resolve();
  if (!isOwner) {
    const moderationRef = db().ref(`${ROOT}/rateLimits/messages/${uid}/moderation`);
    const moderation = (await moderationRef.get()).val() || {};
    if (Number(moderation.cooldownUntil) > now()) throw cooldownError(moderation.cooldownUntil);
    const lastRef = db().ref(`${ROOT}/rateLimits/messages/${uid}/lastAt`);
    const result = await lastRef.transaction((last) => {
      const t = now();
      if (last && t - last < MESSAGE_COOLDOWN) return;
      return t;
    });
    if (!result.committed) await recordMessageViolation(uid, '메시지는 2초에 한 번씩 보낼 수 있습니다.');
    const slot = Math.floor(now() / 60000);
    const countRef = db().ref(`${ROOT}/rateLimits/messages/${uid}/minute/${slot}`);
    const count = await countRef.transaction((value) => (Number(value) || 0) < MESSAGE_LIMIT_PER_MINUTE ? (Number(value) || 0) + 1 : undefined);
    if (!count.committed) await recordMessageViolation(uid, '1분 메시지 제한에 도달했습니다. 잠시 후 다시 시도해 주세요.');
    staleRateBucketCleanup = db().ref(`${ROOT}/rateLimits/messages/${uid}/minute`).child(String(slot - 2)).remove().catch(() => {});
  }
  // Owners can send rapid updates; room-configured repeated text/link limits still apply.
  await checkRepeatedMessage(uid, roomId, text, Number(meta.repeatTextDelaySeconds) || 0, Number(meta.repeatLinkDelaySeconds) || 0);
  return { staleRateBucketCleanup };
}

function activeStickerOwnership(value) {
  return value === true || (!!value && typeof value === 'object' && value.active !== false);
}

async function assertEmoteAvailable(request, uid, sticker) {
  const provider = request.auth && request.auth.token && request.auth.token.firebase
    ? request.auth.token.firebase.sign_in_provider : null;
  let eligible = !!provider && provider !== 'anonymous';
  if (!eligible) eligible = (await sharedDb().ref(`users/${uid}/streamerVerified`).get()).val() === true;
  if (sticker.freeForAuthenticated && eligible) return;
  const ownership = await sharedDb().ref(`gameSeriesShop/ownership/${uid}/${sticker.productId}`).get();
  if (!activeStickerOwnership(ownership.val())) {
    throw new HttpsError('permission-denied', '로그인 유저 또는 인증 스트리머만 무료로 사용할 수 있는 스티커입니다.');
  }
}

async function streamerAvatar(uid) {
  const p = await profileFor(uid);
  return p.avatarUrl || '';
}

async function syncOwnerRoomAvatar(roomId, uid, avatarUrl, meta) {
  if (!meta || meta.ownerUid !== uid) return meta;
  const nextAvatarUrl = String(avatarUrl || '');
  if (String(meta.streamerAvatarUrl || '') === nextAvatarUrl) return meta;
  const updatedAt = now();
  const updatedMeta = { ...meta, streamerAvatarUrl: nextAvatarUrl, updatedAt };
  await db().ref().update({
    [`${ROOT}/rooms/${roomId}/meta`]: updatedMeta,
    [`${ROOT}/publicRooms/${roomId}`]: publicRoom(updatedMeta),
  });
  return updatedMeta;
}

function publicRoom(meta, includeOperational = false) {
  const room = {
    roomId: meta.roomId,
    streamerNickname: meta.streamerNickname,
    streamerSoopId: meta.streamerSoopId,
    roomType: meta.roomType || 'streamer',
    streamerAvatarUrl: meta.streamerAvatarUrl || '',
    visibility: meta.visibility || 'public',
    locked: meta.locked === true,
    updatedAt: Number(meta.updatedAt) || Number(meta.createdAt) || now(),
  };
  if (meta.visibility !== 'private' || includeOperational) room.memberCount = Number(meta.memberCount) || 0;
  if (includeOperational) {
    room.galleryLinked = !!meta.galleryStreamerId;
    room.repeatTextDelaySeconds = Number(meta.repeatTextDelaySeconds) || 0;
    room.repeatLinkDelaySeconds = Number(meta.repeatLinkDelaySeconds) || 0;
  }
  return room;
}

async function ensureUserRoomIndex(uid) {
  const markerRef = db().ref(`${ROOT}/userRoomIndexBackfill/${uid}`);
  const marker = await markerRef.get();
  if (Number(marker.val()?.version) >= 1) return;

  // The reverse index did not exist before this feature. Backfill this account
  // once from room memberships so existing participants also get the shortcut.
  const roomsSnap = await db().ref(`${ROOT}/publicRooms`).get();
  const roomIds = [];
  roomsSnap.forEach((child) => { if (child.key && /^[a-z0-9]{2,30}$/.test(child.key)) roomIds.push(child.key); });
  for (let offset = 0; offset < roomIds.length; offset += 25) {
    const batch = roomIds.slice(offset, offset + 25);
    const matches = await Promise.all(batch.map(async (roomId) => {
      const memberSnap = await roomRef(roomId).child(`members/${uid}`).get();
      const member = memberSnap.val() || {};
      return member.status === 'active' ? [roomId, { joinedAt: Number(member.joinedAt) || 0 }] : null;
    }));
    const updates = {};
    matches.filter(Boolean).forEach(([roomId, value]) => { updates[userRoomIndexPath(uid, roomId)] = value; });
    if (Object.keys(updates).length) await db().ref().update(updates);
  }
  await markerRef.set({ version: 1, backfilledAt: now() });
}

async function resolveGalleryStreamerId(streamerSoopId, streamerNickname) {
  const normalizedId = String(streamerSoopId || '').trim().toLowerCase();
  if (/^[a-z0-9]{2,30}$/.test(normalizedId)) {
    const byId = await sharedDb().ref(`streamerNames/${normalizedId}`).get();
    if (byId.exists()) return normalizedId;
  }
  const wanted = String(streamerNickname || '').trim().toLocaleLowerCase();
  if (!wanted) return '';
  const snap = await sharedDb().ref('streamerNames').get();
  const matches = [];
  snap.forEach((child) => {
    if (String(child.val() || '').trim().toLocaleLowerCase() === wanted) matches.push(child.key);
  });
  return matches.length === 1 ? matches[0] : '';
}

async function ensureGalleryLink(roomId, meta) {
  if (!meta || meta.galleryStreamerId || !['streamer', 'admin'].includes(meta.roomType)) return meta;
  const streamerId = await resolveGalleryStreamerId(meta.streamerSoopId, meta.streamerNickname);
  if (!streamerId) return meta;
  const nextMeta = { ...meta, galleryStreamerId: streamerId, updatedAt: now() };
  await db().ref().update({
    [`${ROOT}/rooms/${roomId}/meta`]: nextMeta,
    [`${ROOT}/publicRooms/${roomId}`]: publicRoom(nextMeta),
  });
  return nextMeta;
}

async function logVerifiedMessengerVisit(principal) {
  if (!principal.streamer || principal.testAccount) return;
  const database = sharedDb();
  if ((await database.ref(`users/${principal.uid}/streamerVerified`).get()).val() !== true) return;
  const dateKey = new Date(now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const dedupRef = database.ref(`verifiedStreamerVisitDedup/streamerMessenger/${principal.uid}/${dateKey}`);
  const result = await dedupRef.transaction((current) => current ? undefined : true);
  if (!result.committed) return;
  try {
    await database.ref('verifiedStreamerVisits').push({
      uid: principal.uid,
      nickname: principal.streamer.nickname || '',
      soopId: principal.streamer.soopId || '',
      market: 'streamerMessenger',
      visitedAt: ServerValue.TIMESTAMP,
    });
  } catch (error) {
    await dedupRef.remove().catch(() => {});
    throw error;
  }
}

const messengerGetSession = onCall(async (request) => {
  const p = await getPrincipal(request);
  try { await logVerifiedMessengerVisit(p); }
  catch (error) { logger.warn('인증 스트리머 메신저 접속 기록 실패', { error: String(error && error.message || error) }); }
  const profile = p.trusted ? await profileFor(p.uid) : null;
  let testAccount = null;
  let testRoom = null;
  if (p.testAccount) {
    const account = (await testAccountRef(p.uid).get()).val() || {};
    if (account.active !== true) throw new HttpsError('permission-denied', '비활성화된 테스트 계정입니다.');
    testAccount = { label: String(account.label || '테스트 계정').slice(0, 40), role: account.role === 'host' ? 'host' : 'participant' };
    const [metaSnap, memberSnap] = await Promise.all([
      roomRef(TEST_ROOM_ID).child('meta').get(),
      roomRef(TEST_ROOM_ID).child(`members/${p.uid}`).get(),
    ]);
    const meta = metaSnap.val() || {};
    if (metaSnap.exists() && meta.roomType === 'test' && memberSnap.val()?.status === 'active') {
      testRoom = publicRoom(meta, meta.ownerUid === p.uid);
    }
  }
  let ownRoom = null;
  const ownRoomId = principalRoomId(p);
  if (ownRoomId) {
    const snap = await roomRef(ownRoomId).child('meta').get();
    if (snap.exists() && snap.val().ownerUid === p.uid) {
      const meta = await syncOwnerRoomAvatar(ownRoomId, p.uid, profile && profile.avatarUrl, snap.val());
      ownRoom = publicRoom(meta, true);
    }
  }
  return { uid: p.uid, trusted: p.trusted, isRealAccount: p.real, isAdmin: p.admin, isVerifiedStreamer: !!p.streamer, streamer: p.streamer, profile, ownRoom, isTestAccount: p.testAccount, testAccount, testRoom };
});

const messengerAdminListTestAccounts = onCall(async (request) => {
  await requireAdmin(request);
  const [accountsSnap, roomSnap] = await Promise.all([testAccountsRef().get(), roomRef(TEST_ROOM_ID).child('meta').get()]);
  const accounts = Object.entries(accountsSnap.val() || {}).map(([uid, value]) => ({
    uid,
    label: String(value && value.label || '테스트 계정').slice(0, 40),
    role: value && value.role === 'host' ? 'host' : 'participant',
    active: !!(value && value.active === true),
    createdAt: Number(value && value.createdAt) || 0,
  })).sort((a, b) => a.createdAt - b.createdAt);
  const meta = roomSnap.val() || {};
  return { room: roomSnap.exists() && meta.roomType === 'test' ? publicRoom(meta, true) : null, accounts };
});

const messengerAdminCreateTestAccount = onCall(async (request) => {
  const admin = await requireAdmin(request);
  const role = String((request.data || {}).role || 'participant');
  if (!['host', 'participant'].includes(role)) throw new HttpsError('invalid-argument', '테스트 계정 유형을 확인해 주세요.');
  const roomMetaRef = roomRef(TEST_ROOM_ID).child('meta');
  const [existingMetaSnap, existingAccountsSnap] = await Promise.all([roomMetaRef.get(), testAccountsRef().get()]);
  const existingMeta = existingMetaSnap.val() || {};
  const existingAccounts = existingAccountsSnap.val() || {};
  if (existingMetaSnap.exists() && existingMeta.roomType !== 'test') throw new HttpsError('already-exists', '테스트방 ID가 기존 채팅방과 충돌합니다.');
  const activeHost = Object.entries(existingAccounts).find(([, value]) => value && value.active === true && value.role === 'host');
  if (role === 'host' && activeHost) throw new HttpsError('already-exists', '테스트 진행자 계정은 이미 있습니다.');
  if (role === 'participant' && (!existingMetaSnap.exists() || !activeHost || existingMeta.ownerUid !== activeHost[0])) {
    throw new HttpsError('failed-precondition', '먼저 테스트 진행자 계정을 만들어 주세요.');
  }

  const nextNumber = Object.values(existingAccounts).filter((value) => value && value.role === role).length + 1;
  const label = role === 'host' ? '테스트 진행자' : `테스트 참여자 ${nextNumber}`;
  const auth = getAuth();
  let userRecord = null;
  let createdRoom = false;
  let registered = false;
  let memberWritten = false;
  try {
    userRecord = await auth.createUser({ displayName: label, disabled: false });
    await auth.setCustomUserClaims(userRecord.uid, { messengerTestAccount: true });
    const profile = role === 'host' ? await profileFor(admin.uid) : null;
    if (role === 'host') {
      const createdAt = now();
      const streamerSoopId = String(profile && profile.soopId || 'messengertest').trim().toLowerCase();
      const meta = {
        roomId: TEST_ROOM_ID,
        ownerUid: userRecord.uid,
        streamerId: 'test-room',
        roomType: 'test',
        galleryStreamerId: await resolveGalleryStreamerId(streamerSoopId, profile && profile.nickname || ''),
        streamerNickname: String(profile && profile.nickname || '테스트 스트리머').slice(0, 30),
        streamerSoopId,
        streamerAvatarUrl: String(profile && profile.avatarUrl || ''),
        visibility: 'private',
        locked: false,
        memberCount: 0,
        createdAt,
        updatedAt: createdAt,
      };
      const result = await roomMetaRef.transaction((current) => current ? undefined : meta, undefined, false);
      if (!result.committed) throw new HttpsError('already-exists', '테스트방을 안전하게 만들지 못했습니다.');
      createdRoom = true;
      await addTestRoomMember(userRecord.uid, { nickname: label }, role, result.snapshot.val());
      memberWritten = true;
      await addTestRoomMember(admin.uid, profile, 'admin', result.snapshot.val());
    } else {
      await addTestRoomMember(userRecord.uid, { nickname: label }, role, existingMeta);
      memberWritten = true;
    }
    await testAccountRef(userRecord.uid).set({ uid: userRecord.uid, label, role, active: true, createdAt: now(), createdByUid: admin.uid });
    registered = true;
    return { uid: userRecord.uid, label, role, roomId: TEST_ROOM_ID };
  } catch (error) {
    if (userRecord) {
      if (!registered) await testAccountRef(userRecord.uid).remove().catch(() => {});
      await db().ref().update({
        [`${ROOT}/rooms/${TEST_ROOM_ID}/members/${userRecord.uid}`]: null,
        [userRoomIndexPath(userRecord.uid, TEST_ROOM_ID)]: null,
        ...(createdRoom ? {
          [`${ROOT}/rooms/${TEST_ROOM_ID}`]: null,
          [userRoomIndexPath(admin.uid, TEST_ROOM_ID)]: null,
        } : {}),
      }).catch(() => {});
      if (memberWritten && !createdRoom) {
        await roomRef(TEST_ROOM_ID).child('meta/memberCount').transaction((count) => Math.max(0, (Number(count) || 0) - 1)).catch(() => {});
      }
      await auth.deleteUser(userRecord.uid).catch(() => {});
    }
    throw error;
  }
});

const messengerAdminJoinTestRoom = onCall(async (request) => {
  const admin = await requireAdmin(request);
  const metaSnap = await roomRef(TEST_ROOM_ID).child('meta').get();
  const meta = metaSnap.val() || {};
  if (!metaSnap.exists() || meta.roomType !== 'test') throw new HttpsError('not-found', '테스트 진행자 계정을 먼저 만들어 주세요.');
  await addTestRoomMember(admin.uid, await profileFor(admin.uid), 'admin', meta);
  const latestMeta = (await roomRef(TEST_ROOM_ID).child('meta').get()).val() || meta;
  return { room: publicRoom(latestMeta, false) };
});

const messengerAdminIssueTestAccountToken = onCall(async (request) => {
  await requireAdmin(request);
  const uid = String((request.data || {}).uid || '');
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(uid)) throw new HttpsError('invalid-argument', '테스트 계정 정보를 확인해 주세요.');
  const account = (await testAccountRef(uid).get()).val() || {};
  if (account.active !== true) throw new HttpsError('not-found', '활성 상태의 테스트 계정을 찾을 수 없습니다.');
  const user = await getAuth().getUser(uid).catch(() => null);
  if (!user || user.disabled || !user.customClaims || user.customClaims.messengerTestAccount !== true) {
    throw new HttpsError('failed-precondition', '테스트 계정 등록 상태가 올바르지 않습니다.');
  }
  const customToken = await getAuth().createCustomToken(uid, { messengerTestAccount: true });
  return { uid, customToken };
});

const messengerGetRoomState = onCall(async (request) => {
  const roomId = String((request.data || {}).roomId || '');
  if (!/^[a-z0-9]{2,30}$/.test(roomId)) throw new HttpsError('invalid-argument', '채팅방 정보가 올바르지 않습니다.');
  const p = await requireRoomPrincipal(request, roomId);
  const [metaSnap, memberSnap, applicationSnap, blockedSnap] = await Promise.all([
    roomRef(roomId).child('meta').get(), roomRef(roomId).child(`members/${p.uid}`).get(),
    roomRef(roomId).child(`applications/${p.uid}`).get(), roomRef(roomId).child(`blocked/${p.uid}`).get(),
  ]);
  if (!metaSnap.exists()) throw new HttpsError('not-found', '채팅방을 찾을 수 없습니다.');
  let meta = metaSnap.val() || {};
  if (meta.roomType === 'test') await requireRoomMember(p, roomId);
  if (meta.ownerUid === p.uid && meta.roomType !== 'test') meta = await syncOwnerRoomAvatar(roomId, p.uid, (await profileFor(p.uid)).avatarUrl, meta);
  return { room: publicRoom(meta, meta.ownerUid === p.uid), isOwner: meta.ownerUid === p.uid, member: memberSnap.val() || null, application: applicationSnap.val() || null, blocked: blockedSnap.exists() };
});

const messengerListMyRooms = onCall({ timeoutSeconds: 120 }, async (request) => {
  const p = await getPrincipal(request);
  if (!p.trusted && !p.testAccount) throw new HttpsError('permission-denied', 'Google/카카오 로그인 또는 스트리머 인증 후 이용해 주세요.');
  if (p.testAccount && (await testAccountRef(p.uid).get()).val()?.active !== true) throw new HttpsError('permission-denied', '비활성화된 테스트 계정입니다.');
  await ensureUserRoomIndex(p.uid);
  const indexRef = db().ref(`${ROOT}/userRoomIndex/${p.uid}`);
  const indexSnap = await indexRef.get();
  const entries = Object.entries(indexSnap.val() || {}).sort((a, b) => (Number(b[1]?.joinedAt) || 0) - (Number(a[1]?.joinedAt) || 0));
  const rooms = [];
  const stale = {};
  for (let offset = 0; offset < entries.length; offset += 25) {
    const batch = entries.slice(offset, offset + 25);
    const results = await Promise.all(batch.map(async ([roomId, indexed]) => {
      if (!/^[a-z0-9]{2,30}$/.test(roomId)) return { roomId, stale: true };
      const [metaSnap, memberSnap] = await Promise.all([
        roomRef(roomId).child('meta').get(), roomRef(roomId).child(`members/${p.uid}`).get(),
      ]);
      const meta = metaSnap.val() || {};
      const member = memberSnap.val() || {};
      if (!metaSnap.exists() || member.status !== 'active') return { roomId, stale: true };
      if (meta.roomType === 'test' && !p.admin && !p.testAccount) return { roomId, stale: true };
      if (p.testAccount && meta.roomType !== 'test') return { roomId, stale: true };
      return { room: publicRoom(meta), joinedAt: Number(member.joinedAt) || Number(indexed?.joinedAt) || 0 };
    }));
    results.forEach((result) => {
      if (result.stale) stale[userRoomIndexPath(p.uid, result.roomId)] = null;
      else rooms.push({ ...result.room, joinedAt: result.joinedAt });
    });
  }
  if (Object.keys(stale).length) await db().ref().update(stale);
  rooms.sort((a, b) => b.joinedAt - a.joinedAt || String(a.streamerNickname || '').localeCompare(String(b.streamerNickname || ''), 'ko'));
  return { rooms };
});

const messengerEnsureRoom = onCall(async (request) => {
  const p = await getPrincipal(request, { requireTrusted: true });
  if (p.testAccount) throw new HttpsError('permission-denied', '테스트 계정은 일반 채팅방을 만들 수 없습니다.');
  const roomId = principalRoomId(p);
  if (!roomId) throw new HttpsError('permission-denied', '인증된 스트리머 또는 관리자만 채팅방을 만들 수 있습니다.');
  return ensureOwnedRoom(p.uid, roomId, p.streamer || null);
});

async function ensureOwnedRoom(uid, streamerRoomId, streamer = null) {
  const roomId = String(streamerRoomId || '').trim().toLowerCase();
  if (!/^[a-z0-9]{2,30}$/.test(roomId)) throw new HttpsError('permission-denied', '채팅방에 연결된 SOOP 아이디가 올바르지 않습니다.');

  const profile = await profileFor(uid);
  const roomType = streamer ? 'streamer' : 'admin';
  const streamerNickname = String(streamer && streamer.nickname || profile.nickname || '관리자').trim().slice(0, 30);
  const streamerSoopId = streamer ? roomId : profile.soopId;
  const galleryStreamerId = await resolveGalleryStreamerId(streamerSoopId, streamerNickname);
  const createdAt = now();
  const candidate = {
    roomId,
    ownerUid: uid,
    streamerId: streamer ? roomId : `admin:${uid}`,
    roomType,
    galleryStreamerId: galleryStreamerId || null,
    streamerNickname,
    streamerSoopId,
    streamerAvatarUrl: profile.avatarUrl || '',
    visibility: 'public',
    locked: false,
    memberCount: 0,
    createdAt,
    updatedAt: createdAt,
  };

  const metaRef = roomRef(roomId).child('meta');
  const result = await metaRef.transaction((current) => current ? undefined : candidate, undefined, false);
  const meta = result.snapshot.val() || {};
  if (meta.ownerUid !== uid) throw new HttpsError('already-exists', '이 스트리머 아이디의 채팅방이 이미 존재합니다.');

  let finalMeta = meta;
  if (result.committed) {
    await db().ref(`${ROOT}/publicRooms/${roomId}`).set(publicRoom(finalMeta));
    await writeAudit(uid, 'room.create', roomId);
  } else {
    finalMeta = await syncOwnerRoomAvatar(roomId, uid, profile.avatarUrl, finalMeta);
    finalMeta = await ensureGalleryLink(roomId, finalMeta);
    const listing = await db().ref(`${ROOT}/publicRooms/${roomId}`).get();
    if (!listing.exists()) await listing.ref.set(publicRoom(finalMeta));
  }

  return { room: publicRoom(finalMeta, true), created: result.committed };
}

// streamerVerifications is the shared verification ledger written by the
// integrated admin center's approval flow (and sibling verification flows).
// Creating the room here keeps approval server-side and idempotent; it does not
// add members or approve any fan applications.
const messengerAutoCreateVerifiedStreamerRoom = onValueWritten({
  ref: '/streamerVerifications/{recordId}',
  instance: MAIN_DATABASE_INSTANCE,
  region: 'us-central1',
  retry: true,
}, async (event) => {
  if (await isMessengerDatabaseMigrationPaused()) throw new Error('Messenger database migration is paused.');
  const before = event.data.before.val() || null;
  const after = event.data.after.val() || null;
  if (!after || !after.uid) return null;
  if (before && before.uid === after.uid && before.nickname === after.nickname && before.soopId === after.soopId) return null;

  const uid = String(after.uid);
  const recordRef = sharedDb().ref(`streamerVerifications/${event.params.recordId}`);
  const currentRecord = (await recordRef.get()).val() || {};
  if (String(currentRecord.uid || '') !== uid) return null;
  const verified = await getVerifiedStreamer(uid);
  const roomId = String(verified && verified.soopId || '').trim().toLowerCase();
  if (!verified || !/^[a-z0-9]{2,30}$/.test(roomId) || roomId !== String(currentRecord.soopId || '').trim().toLowerCase()) return null;

  try {
    const result = await ensureOwnedRoom(uid, roomId, verified);
    logger.info('자동 인증 채팅방 확인 완료', { uid, roomId, created: result.created });
  } catch (error) {
    if (error && error.code === 'already-exists') {
      logger.warn('기존 소유 채팅방이 있어 자동 생성하지 않았습니다.', { uid, roomId });
      return null;
    }
    logger.error('인증 스트리머 채팅방 자동 생성 실패', { uid, roomId, error: error && error.message || String(error) });
    throw error;
  }
  return null;
});

const messengerAdminBackfillVerifiedRooms = onCall(async (request) => {
  const admin = await requireAdmin(request);
  const statusRef = db().ref(`${ROOT}/admin/verifiedRoomBackfill`);
  const lock = await statusRef.transaction((current) => {
    const value = current || {};
    if (value.status === 'running' && now() - Number(value.startedAt || 0) < 10 * 60 * 1000) return;
    return { version: 2, status: 'running', startedAt: now(), startedBy: admin.uid };
  }, undefined, false);
  if (!lock.committed) {
    const current = lock.snapshot.val() || {};
    return { complete: current.status === 'complete', inProgress: current.status === 'running', created: 0, existing: 0, skipped: 0 };
  }

  try {
    const records = await sharedDb().ref('streamerVerifications').get();
    const uids = new Set();
    records.forEach((child) => {
      const value = child.val() || {};
      if (typeof value.uid === 'string' && value.uid) uids.add(value.uid);
    });

    const summary = { created: 0, existing: 0, skipped: 0 };
    const accounts = Array.from(uids);
    for (let offset = 0; offset < accounts.length; offset += 4) {
      await Promise.all(accounts.slice(offset, offset + 4).map(async (uid) => {
        const streamer = await getVerifiedStreamer(uid);
        const roomId = String(streamer && streamer.soopId || '').trim().toLowerCase();
        if (!streamer || !/^[a-z0-9]{2,30}$/.test(roomId)) { summary.skipped += 1; return; }
        const [metaSnap, listingSnap] = await Promise.all([
          roomRef(roomId).child('meta').get(),
          db().ref(`${ROOT}/publicRooms/${roomId}`).get(),
        ]);
        const currentMeta = metaSnap.val() || {};
        if (metaSnap.exists() && (currentMeta.ownerUid !== uid || (currentMeta.roomType || 'streamer') !== 'streamer')) {
          summary.skipped += 1;
          return;
        }
        if (metaSnap.exists() && listingSnap.exists()) {
          summary.existing += 1;
          return;
        }
        try {
          const result = await ensureOwnedRoom(uid, roomId, streamer);
          if (result.created) summary.created += 1;
          else summary.existing += 1;
        } catch (error) {
          if (error && error.code === 'already-exists') { summary.skipped += 1; return; }
          throw error;
        }
      }));
    }

    await statusRef.set({ version: 2, status: 'complete', startedAt: Number(lock.snapshot.val().startedAt) || now(), completedAt: now(), completedBy: admin.uid, verifiedUidCount: accounts.length, ...summary });
    return { complete: true, ...summary };
  } catch (error) {
    await statusRef.set({ version: 2, status: 'failed', failedAt: now(), failedBy: admin.uid, errorCode: String(error && error.code || 'unknown').slice(0, 80) });
    throw error;
  }
});

const messengerUpdateRoom = onCall(async (request) => {
  const { roomId, visibility, password, regeneratePassword, locked, memberPolicy } = request.data || {};
  const data = request.data || {};
  const p = await requireRoomPrincipal(request, roomId);
  const result = await requireRoomMember(p, String(roomId || ''));
  if (!result.isOwner) throw new HttpsError('permission-denied', '채팅방 소유자만 설정을 변경할 수 있습니다.');
  if (!['public', 'private'].includes(visibility)) throw new HttpsError('invalid-argument', '방 공개 설정이 올바르지 않습니다.');
  const meta = result.meta;
  const repeatTextDelaySeconds = data.repeatTextDelaySeconds === undefined ? Number(meta.repeatTextDelaySeconds) || 0 : Number(data.repeatTextDelaySeconds);
  const repeatLinkDelaySeconds = data.repeatLinkDelaySeconds === undefined ? Number(meta.repeatLinkDelaySeconds) || 0 : Number(data.repeatLinkDelaySeconds);
  if (![repeatTextDelaySeconds, repeatLinkDelaySeconds].every((value) => Number.isInteger(value) && value >= 0 && value <= 3600)) throw new HttpsError('invalid-argument', '반복 차단 시간은 0~3600초 사이의 정수로 입력해 주세요.');
  const metaPatch = { visibility, locked: locked === true, repeatTextDelaySeconds, repeatLinkDelaySeconds, updatedAt: now() };
  const updates = {};
  let passwordChanged = false;
  let generatedPassword = '';
  if (visibility === 'public') { metaPatch.passwordSalt = null; metaPatch.passwordHash = null; }
  else if (typeof password === 'string' && password.length) {
    if (password.length < 4 || password.length > 64) throw new HttpsError('invalid-argument', '비밀번호는 4~64자로 입력해 주세요.');
    const salt = crypto.randomBytes(16).toString('hex');
    metaPatch.passwordSalt = salt; metaPatch.passwordHash = await passwordDigest(password, salt);
    passwordChanged = true;
  } else if (regeneratePassword === true || meta.visibility !== 'private' || !meta.passwordHash) {
    generatedPassword = generateRoomPassword();
    const salt = crypto.randomBytes(16).toString('hex');
    metaPatch.passwordSalt = salt; metaPatch.passwordHash = await passwordDigest(generatedPassword, salt);
    passwordChanged = true;
  } else if (!meta.passwordSalt || !meta.passwordHash) throw new HttpsError('failed-precondition', '비밀번호를 새로 발급할 수 없습니다. 다시 시도해 주세요.');
  if (passwordChanged && !['keep', 'remove'].includes(memberPolicy)) {
    throw new HttpsError('invalid-argument', '비밀번호 변경 시 참여자 처리 방식을 선택해 주세요.');
  }
  if (passwordChanged && memberPolicy === 'remove') {
    const membersSnap = await roomRef(roomId).child('members').get();
    const members = membersSnap.val() || {};
    Object.keys(members).forEach((uid) => {
      if (members[uid] && members[uid].status === 'active') {
        updates[`${ROOT}/rooms/${roomId}/members/${uid}/status`] = 'removed';
        updates[userRoomIndexPath(uid, roomId)] = null;
      }
    });
    metaPatch.memberCount = 0;
  }
  const nextMeta = { ...meta, ...metaPatch };
  updates[`${ROOT}/rooms/${roomId}/meta`] = nextMeta;
  if (meta.roomType !== 'test') updates[`${ROOT}/publicRooms/${roomId}`] = publicRoom(nextMeta);
  await db().ref().update(updates);
  await writeAudit(p.uid, 'room.update', roomId);
  return { room: publicRoom(nextMeta, true), generatedPassword: generatedPassword || null };
});

const messengerDiscardRoom = onCall({ secrets: [roomselfAccessKeyId, roomselfSecretAccessKey], timeoutSeconds: 540, memory: '1GiB' }, async (request) => {
  const p = await getPrincipal(request, { requireTrusted: true });
  if (p.testAccount) throw new HttpsError('permission-denied', '테스트 계정에서는 테스트방을 폐기할 수 없습니다.');
  const roomId = String((request.data || {}).roomId || '');
  const { meta, isOwner } = await requireRoomMember(p, roomId);
  if (!isOwner) throw new HttpsError('permission-denied', '채팅방 소유자만 방을 폐기할 수 있습니다.');
  const generation = await ensureMessageArchiveGeneration(roomId);
  const [reports, membersSnap, liveRoomselfImageIds] = await Promise.all([
    db().ref(`${ROOT}/reports`).orderByChild('roomId').equalTo(roomId).get(),
    roomRef(roomId).child('members').get(),
    listLiveRoomselfImageIds(roomId),
  ]);
  const liveImageIds = [...liveRoomselfImageIds];
  for (let offset = 0; offset < liveImageIds.length; offset += 400) {
    const imageUpdates = {};
    for (const imageId of liveImageIds.slice(offset, offset + 400)) imageUpdates[`${archivedRoomselfImagesPath(roomId, generation)}/${imageId}`] = true;
    await db().ref().update(imageUpdates);
  }
  const updates = { [`${ROOT}/rooms/${roomId}`]: null, [`${ROOT}/publicRooms/${roomId}`]: null, [`${ROOT}/chat/${roomId}`]: null, [`${ROOT}/roomMarkets/${roomId}`]: null };
  membersSnap.forEach((child) => { if (child.key) updates[userRoomIndexPath(child.key, roomId)] = null; });
  const cleanupId = `${roomId}_${generation}`;
  updates[`${ROOT}/messageArchiveIndex/${roomId}/${generation}`] = null;
  updates[`${ROOT}/messageArchiveCleanup/${cleanupId}`] = { roomId, generation, requestedAt: now() };
  reports.forEach((child) => {
    const report = child.val() || {};
    if (Number(report.retainUntil) < now()) {
      updates[`${ROOT}/reports/${child.key}`] = null;
      updates[`${ROOT}/reportEvidence/${child.key}`] = null;
    }
  });
  await db().ref().update(updates);
  try { await cleanMessageArchiveQueue(roomselfS3()); }
  catch (error) { logger.warn('채팅방 보관 파일 정리가 다음 정리 작업으로 미뤄졌습니다.', { roomId, error: String(error && error.message || error) }); }
  await writeAudit(p.uid, 'room.discard', roomId);
  return { discarded: true, streamerNickname: meta.streamerNickname };
});

const messengerApplyToRoom = onCall(async (request) => {
  const p = await getPrincipal(request, { requireTrusted: true });
  if (p.testAccount) throw new HttpsError('permission-denied', '테스트 계정은 일반 채팅방에 대화를 신청할 수 없습니다.');
  const roomId = String((request.data || {}).roomId || '');
  if (!/^[a-z0-9]{2,30}$/.test(roomId)) throw new HttpsError('invalid-argument', '채팅방 정보가 올바르지 않습니다.');
  const [metaSnap, existingSnap, blockedSnap] = await Promise.all([
    roomRef(roomId).child('meta').get(), roomRef(roomId).child(`applications/${p.uid}`).get(), roomRef(roomId).child(`blocked/${p.uid}`).get(),
  ]);
  if (!metaSnap.exists()) throw new HttpsError('not-found', '채팅방을 찾을 수 없습니다.');
  const meta = metaSnap.val();
  if (meta.ownerUid === p.uid) throw new HttpsError('failed-precondition', '본인 채팅방에는 신청할 수 없습니다.');
  if (blockedSnap.exists()) throw new HttpsError('permission-denied', '이 채팅방에 다시 신청할 수 없습니다.');
  const old = existingSnap.val() || {};
  if (old.status === 'pending' && now() < Number(old.expiresAt || 0)) throw new HttpsError('already-exists', '이미 대기 중인 신청이 있습니다.');
  if (old.status === 'rejected' && now() < Number(old.reapplyAt || 0)) throw new HttpsError('failed-precondition', '거절 후 3일이 지나야 다시 신청할 수 있습니다.');
  const member = await roomRef(roomId).child(`members/${p.uid}`).get();
  if (member.exists() && member.val().status === 'active') throw new HttpsError('already-exists', '이미 참여 중인 채팅방입니다.');
  await assertRoomPassword(meta, (request.data || {}).password);
  const profile = await assertProfile(p.uid);
  await applyCooldown(p.uid, roomId);
  const submittedAt = now();
  const intro = safeText((request.data || {}).intro || '', INTRO_MAX);
  await roomRef(roomId).child(`applications/${p.uid}`).set({ uid: p.uid, profile, intro, status: 'pending', submittedAt, expiresAt: submittedAt + APPLICATION_EXPIRE, roomId });
  return { status: 'pending', expiresAt: submittedAt + APPLICATION_EXPIRE };
});

const messengerListApplications = onCall(async (request) => {
  const roomId = String((request.data || {}).roomId || '');
  const p = await requireRoomPrincipal(request, roomId);
  const result = await requireRoomMember(p, roomId);
  if (!result.isOwner) throw new HttpsError('permission-denied', '스트리머만 신청 목록을 확인할 수 있습니다.');
  const snap = await roomRef(roomId).child('applications').get();
  const items = Object.values(snap.val() || {}).filter((item) => item && item.status === 'pending');
  return { applications: items.sort((a, b) => a.submittedAt - b.submittedAt) };
});

const messengerListFans = onCall(async (request) => {
  const roomId = String((request.data || {}).roomId || '');
  const p = await requireRoomPrincipal(request, roomId);
  const { isOwner } = await requireRoomMember(p, roomId);
  if (!isOwner) throw new HttpsError('permission-denied', '스트리머만 팬 목록을 볼 수 있습니다.');
  const snap = await roomRef(roomId).child('members').get();
  const fans = [];
  snap.forEach((child) => {
    const member = child.val() || {};
    if (member.status === 'active' || member.status === 'blocked') fans.push({ uid: child.key, status: member.status, profile: member.profile || {}, joinedAt: member.joinedAt || 0 });
  });
  fans.sort((a, b) => b.joinedAt - a.joinedAt);
  return { fans };
});

const messengerReviewApplication = onCall(async (request) => {
  const { roomId, uid, decision } = request.data || {};
  const p = await requireRoomPrincipal(request, roomId);
  const result = await requireRoomMember(p, String(roomId || ''));
  if (!result.isOwner) throw new HttpsError('permission-denied', '스트리머만 신청을 처리할 수 있습니다.');
  if (!['approved', 'rejected'].includes(decision) || typeof uid !== 'string') throw new HttpsError('invalid-argument', '신청 처리 정보가 올바르지 않습니다.');
  const appRef = roomRef(roomId).child(`applications/${uid}`);
  const snap = await appRef.get();
  const application = snap.val();
  if (!application || application.status !== 'pending') throw new HttpsError('failed-precondition', '대기 중인 신청이 아닙니다.');
  if ((await roomRef(roomId).child(`blocked/${uid}`).get()).exists()) throw new HttpsError('permission-denied', '차단된 계정은 승인할 수 없습니다.');
  if (now() >= Number(application.expiresAt || 0)) {
    await appRef.update({ status: 'expired', resolvedAt: now() });
    throw new HttpsError('deadline-exceeded', '신청 기한이 지났습니다.');
  }
  const at = now();
  const updates = { [`${ROOT}/rooms/${roomId}/applications/${uid}/status`]: decision, [`${ROOT}/rooms/${roomId}/applications/${uid}/resolvedAt`]: at };
  if (decision === 'approved') {
    const member = { uid, status: 'active', joinedAt: at, profile: application.profile };
    updates[`${ROOT}/rooms/${roomId}/members/${uid}`] = member;
    updates[userRoomIndexPath(uid, roomId)] = { joinedAt: at };
    updates[`${ROOT}/rooms/${roomId}/meta/memberCount`] = (Number(result.meta.memberCount) || 0) + 1;
    if (result.meta.roomType !== 'test') updates[`${ROOT}/publicRooms/${roomId}/memberCount`] = (Number(result.meta.memberCount) || 0) + 1;
  } else updates[`${ROOT}/rooms/${roomId}/applications/${uid}/reapplyAt`] = at + APPLICATION_EXPIRE;
  await db().ref().update(updates);
  return { status: decision };
});

const messengerSetMemberStatus = onCall(async (request) => {
  const { roomId, uid, status } = request.data || {};
  const p = await requireRoomPrincipal(request, roomId);
  const result = await requireRoomMember(p, String(roomId || ''));
  if (!result.isOwner || typeof uid !== 'string' || !['blocked', 'active'].includes(status)) throw new HttpsError('permission-denied', '요청을 처리할 수 없습니다.');
  if (result.meta.roomType === 'test' && (await sharedDb().ref(`adminCenter/adminUids/${uid}`).get()).val() === true) {
    throw new HttpsError('failed-precondition', '테스트방을 관리하는 관리자 계정은 차단할 수 없습니다.');
  }
  const memberSnap = await roomRef(roomId).child(`members/${uid}`).get();
  const updates = {};
  updates[`${ROOT}/rooms/${roomId}/members/${uid}/status`] = status;
  updates[`${ROOT}/rooms/${roomId}/members/${uid}/updatedAt`] = now();
  updates[userRoomIndexPath(uid, roomId)] = null;
  if (status === 'blocked') {
    updates[`${ROOT}/rooms/${roomId}/blocked/${uid}`] = { at: now(), by: p.uid };
    updates[`${ROOT}/rooms/${roomId}/meta/memberCount`] = Math.max(0, (Number(result.meta.memberCount) || 0) - (memberSnap.val() && memberSnap.val().status === 'active' ? 1 : 0));
    if (result.meta.roomType !== 'test') updates[`${ROOT}/publicRooms/${roomId}/memberCount`] = Math.max(0, (Number(result.meta.memberCount) || 0) - (memberSnap.val() && memberSnap.val().status === 'active' ? 1 : 0));
  } else {
    updates[`${ROOT}/rooms/${roomId}/blocked/${uid}`] = null;
    updates[`${ROOT}/rooms/${roomId}/members/${uid}`] = null;
  }
  await db().ref().update(updates);
  await writeAudit(p.uid, `member.${status}`, `${roomId}/${uid}`);
  return { status };
});

function isRoomMarketStockNameForStreamer(stockName, streamerName) {
  const normalize = (value) => String(value || '').normalize('NFC').trim().toLocaleLowerCase('ko-KR');
  const stock = normalize(stockName);
  const streamer = normalize(streamerName);
  if (!stock || !streamer) return false;
  if (stock === streamer) return true;
  const crewPrefixedName = stock.match(/^\[crew\]\s*(.+)$/);
  return !!crewPrefixedName && normalize(crewPrefixedName[1]) === streamer;
}

const messengerRoomMarketUpdate = onCall(async (request) => {
  const { roomId: rawRoomId, stockId: rawStockId, action } = request.data || {};
  const roomId = String(rawRoomId || '');
  const stockId = String(rawStockId || '');
  const p = await requireRoomPrincipal(request, roomId);
  if (!['add', 'remove'].includes(action)) throw new HttpsError('invalid-argument', '요청이 올바르지 않습니다.');
  if (!/^[a-z0-9]{2,30}$/.test(roomId)) throw new HttpsError('invalid-argument', '채팅방 정보가 올바르지 않습니다.');
  const { isOwner, meta } = await requireRoomMember(p, roomId);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(stockId)) throw new HttpsError('invalid-argument', '종목 정보가 올바르지 않습니다.');
  const stocksRef = db().ref(`${ROOT}/roomMarkets/${roomId}/stocks`);

  if (action === 'remove') {
    if (!isOwner) throw new HttpsError('permission-denied', '스트리머만 공유 종목을 제거할 수 있습니다.');
    await stocksRef.child(stockId).remove();
    try { await writeAudit(p.uid, 'roomMarket.stock.remove', `${roomId}/${stockId}`); }
    catch (error) { logger.warn('공유 종목 제거 감사 기록 실패', error); }
    return { action, removed: true };
  }

  const publicStockSnap = await sharedDb().ref(`stocksPublic/${stockId}`).get();
  const stockSnap = await sharedDb().ref(`stocks/${stockId}`).get();
  if (!publicStockSnap.exists() || !stockSnap.exists()) throw new HttpsError('not-found', '현재 거래할 수 있는 종목이 아닙니다.');
  const stock = stockSnap.val() || {};
  if (!isRoomMarketStockNameForStreamer(stock.name, meta.streamerNickname)) {
    throw new HttpsError('failed-precondition', '이 채팅방에서는 해당 스트리머의 종목만 연결할 수 있습니다.');
  }
  const addedAt = now();
  let alreadyAdded = false;
  const result = await stocksRef.transaction((current) => {
    const stocks = current || {};
    alreadyAdded = Object.prototype.hasOwnProperty.call(stocks, stockId) && Object.keys(stocks).length === 1;
    if (alreadyAdded) return stocks;
    return { [stockId]: { stockId, name: String(stock.name || stockId).slice(0, 80), addedAt } };
  });
  if (!result.committed) throw new HttpsError('aborted', '스트리머 종목을 연결하지 못했습니다. 다시 시도해 주세요.');
  try { await writeAudit(p.uid, 'roomMarket.stock.add', `${roomId}/${stockId}`); }
  catch (error) { logger.warn('공유 종목 추가 감사 기록 실패', error); }
  return { action, stock: result.snapshot.child(stockId).val(), alreadyAdded };
});

const messengerSetPinnedMessage = onCall({ maxInstances: 20 }, async (request) => {
  const data = request.data || {};
  const roomId = String(data.roomId || '');
  const messageId = data.messageId;
  const p = await requireRoomPrincipal(request, roomId);
  if (!/^[a-z0-9]{2,30}$/.test(roomId) || typeof messageId !== 'string') {
    throw new HttpsError('invalid-argument', '채팅방 또는 메시지 정보가 올바르지 않습니다.');
  }
  const { isOwner } = await requireRoomMember(p, roomId);
  if (!isOwner) throw new HttpsError('permission-denied', '채팅방 소유자만 메시지를 고정할 수 있습니다.');
  const pinnedRef = roomRef(roomId).child('meta/pinnedMessage');
  if (!messageId) {
    await pinnedRef.remove();
    return { pinnedMessage: null };
  }
  if (!/^[A-Za-z0-9_-]{20}$/.test(messageId)) throw new HttpsError('invalid-argument', '메시지 식별자가 올바르지 않습니다.');

  const timelineSnap = await db().ref(`${ROOT}/chat/${roomId}/streamerTimeline/${messageId}`).get();
  if (!timelineSnap.exists()) throw new HttpsError('not-found', '고정할 메시지를 찾을 수 없습니다.');
  const timelineMessage = timelineSnap.val() || {};
  let message = null;
  if (timelineMessage.senderRole === 'streamer' && timelineMessage.senderUid === p.uid && !timelineMessage.recipientUid) {
    const broadcastSnap = await db().ref(`${ROOT}/chat/${roomId}/broadcast/${messageId}`).get();
    const broadcastMessage = broadcastSnap.val() || {};
    const isPublicStreamerMessage = broadcastSnap.exists() && broadcastMessage.id === messageId && broadcastMessage.roomId === roomId
      && broadcastMessage.senderRole === 'streamer' && broadcastMessage.senderUid === p.uid && !broadcastMessage.recipientUid
      && ['text', 'image'].includes(broadcastMessage.kind)
      && timelineMessage.id === messageId && timelineMessage.roomId === roomId
      && timelineMessage.kind === broadcastMessage.kind
      && Number(timelineMessage.createdAt) === Number(broadcastMessage.createdAt)
      && (broadcastMessage.kind !== 'text' || timelineMessage.text === broadcastMessage.text)
      && (broadcastMessage.kind !== 'image' || timelineMessage.galleryImageId === broadcastMessage.galleryImageId);
    if (isPublicStreamerMessage) message = broadcastMessage;
  } else if (timelineMessage.senderRole === 'fan' && timelineMessage.senderUid && timelineMessage.senderUid !== p.uid && !timelineMessage.recipientUid) {
    const privateSnap = await db().ref(`${ROOT}/chat/${roomId}/private/${timelineMessage.senderUid}/${messageId}`).get();
    const privateMessage = privateSnap.val() || {};
    const isFanMessage = privateSnap.exists() && timelineMessage.id === messageId && timelineMessage.roomId === roomId
      && privateMessage.id === messageId && privateMessage.roomId === roomId
      && privateMessage.senderUid === timelineMessage.senderUid && privateMessage.senderRole === 'fan'
      && privateMessage.scope === 'fan' && !privateMessage.recipientUid
      && Number(privateMessage.createdAt) === Number(timelineMessage.createdAt)
      && ['text', 'image'].includes(privateMessage.kind) && privateMessage.kind === timelineMessage.kind
      && (privateMessage.kind !== 'text' || privateMessage.text === timelineMessage.text)
      && (privateMessage.kind !== 'image' || privateMessage.galleryImageId === timelineMessage.galleryImageId);
    if (isFanMessage) message = privateMessage;
  }
  if (!message) throw new HttpsError('permission-denied', '방 전체 공개 메시지 또는 팬 대화의 메시지만 고정할 수 있습니다.');
  const messageCreatedAt = Number(message.createdAt) || 0;
  if (messageCreatedAt < now() - CHAT_RETENTION) throw new HttpsError('failed-precondition', '보관 기간이 지난 메시지는 고정할 수 없습니다.');
  if (message.kind === 'text' && (typeof message.text !== 'string' || !message.text.trim())) {
    throw new HttpsError('failed-precondition', '내용이 있는 메시지만 고정할 수 있습니다.');
  }
  if (message.kind === 'image' && typeof message.galleryImageId !== 'string') {
    throw new HttpsError('failed-precondition', '갤러리 이미지 정보를 확인할 수 없습니다.');
  }

  const publicSnapshot = {
    id: messageId,
    roomId,
    senderRole: message.senderRole,
    senderName: String(message.senderName || (message.senderRole === 'fan' ? '팬' : '스트리머')).slice(0, 30),
    createdAt: messageCreatedAt,
    kind: message.kind,
    ...(message.kind === 'text' ? { text: message.text } : { galleryImageId: message.galleryImageId }),
  };
  const pinnedMessage = { messageId, messageCreatedAt, pinnedAt: now(), message: publicSnapshot };
  await pinnedRef.set(pinnedMessage);
  return { pinnedMessage };
});

function createLadderRungs(laneCount) {
  const rungs = [];
  for (let row = 0; row < LADDER_ROW_COUNT; row += 1) {
    const edges = Array.from({ length: laneCount - 1 }, (_, index) => index);
    for (let index = edges.length - 1; index > 0; index -= 1) {
      const swapIndex = crypto.randomInt(index + 1);
      [edges[index], edges[swapIndex]] = [edges[swapIndex], edges[index]];
    }
    const targetCount = crypto.randomInt(0, Math.floor(laneCount / 2) + 1);
    if (targetCount === 0) {
      rungs.push([]);
      continue;
    }
    const selected = [];
    for (const edge of edges) {
      if (selected.some((existing) => Math.abs(existing - edge) === 1)) continue;
      selected.push(edge);
      if (selected.length >= targetCount) break;
    }
    rungs.push(selected.sort((a, b) => a - b));
  }
  if (rungs.every((row) => row.length === 0)) {
    rungs[crypto.randomInt(LADDER_ROW_COUNT)].push(crypto.randomInt(laneCount - 1));
  }
  return rungs;
}

function isRenderableActiveLadder(game, currentTime = now()) {
  return !!game
    && game.gameType === 'ladder'
    && game.status === 'active'
    && /^[a-f0-9]{24}$/.test(String(game.gameId || ''))
    && Number.isFinite(Number(game.expiresAt))
    && Number(game.expiresAt) > currentTime
    && Array.isArray(game.players)
    && game.players.length >= 2
    && game.players.length <= LADDER_PLAYER_LIMIT
    && Array.isArray(game.outcomes)
    && game.outcomes.length === game.players.length
    && Array.isArray(game.rungs)
    && game.rungs.length > 0
    && game.rungs.every(Array.isArray);
}

function ladderResultText(game) {
  const players = Array.isArray(game.players) ? game.players.map((value) => safeText(value, 24, true)) : [];
  const outcomes = Array.isArray(game.outcomes) ? game.outcomes.map((value) => safeText(value, 24, true)) : [];
  const rungs = Array.isArray(game.rungs)
    ? Array.from({ length: Math.min(game.rungs.length, LADDER_ROW_COUNT) }, (_, index) => (
      Array.isArray(game.rungs[index]) ? game.rungs[index] : []
    ))
    : [];
  if (players.length < 2 || players.length > LADDER_PLAYER_LIMIT || outcomes.length !== players.length || !rungs.length) {
    throw new HttpsError('failed-precondition', '사다리 결과 데이터가 올바르지 않아 결과를 공유할 수 없습니다.');
  }
  const pairs = players.map((player, startLane) => {
    let lane = startLane;
    for (const row of rungs) {
      const edge = row.find((candidate) => Number.isInteger(candidate) && candidate >= 0 && candidate < players.length - 1
        && (candidate === lane || candidate + 1 === lane));
      if (Number.isInteger(edge)) lane = edge === lane ? lane + 1 : lane - 1;
    }
    return `${player} → ${outcomes[lane]}`;
  });
  return `사다리타기 결과:\n${pairs.join('\n')}`;
}

const messengerMiniGameUpdate = onCall({ maxInstances: 20 }, async (request) => {
  const data = request.data || {};
  const roomId = String(data.roomId || '');
  const action = String(data.action || '');
  const p = await requireRoomPrincipal(request, roomId);
  if (!/^[a-z0-9]{2,30}$/.test(roomId) || !['start', 'select', 'finish', 'clear', 'sync'].includes(action)) {
    throw new HttpsError('invalid-argument', '채팅방 또는 미니게임 요청 정보가 올바르지 않습니다.');
  }
  const { meta, isOwner } = await requireRoomMember(p, roomId);
  const canManage = isOwner || (p.admin && meta.roomType === 'admin');
  if (!canManage) throw new HttpsError('permission-denied', '채팅방 소유자 또는 관리자 방의 관리자만 사다리 게임을 시작하거나 종료할 수 있습니다.');
  const gameRef = roomRef(roomId).child('meta/miniGame');
  if (action === 'sync') {
    const snapshot = await gameRef.get();
    const current = snapshot.val();
    return { miniGame: isRenderableActiveLadder(current) ? current : null };
  }
  if (action === 'select') {
    const gameId = String(data.gameId || '');
    const participantIndex = Number(data.participantIndex);
    if (!/^[a-f0-9]{24}$/.test(gameId) || !Number.isInteger(participantIndex) || participantIndex < 0 || participantIndex >= LADDER_PLAYER_LIMIT) {
      throw new HttpsError('invalid-argument', '선택한 사다리 참가자 정보가 올바르지 않습니다.');
    }
    const observed = (await gameRef.get()).val();
    const isSelectableLadder = (game) => !!game && game.gameType === 'ladder' && game.status === 'active'
      && Number.isFinite(Number(game.expiresAt)) && Number(game.expiresAt) > now()
      && Array.isArray(game.players) && participantIndex < game.players.length
      && !game.finishClaim && String(game.gameId || '') === gameId;
    if (!isSelectableLadder(observed)) {
      return { miniGame: observed && observed.gameType === 'ladder' && observed.status === 'active' ? observed : null, stale: true };
    }
    let seededFromServerSnapshot = false;
    const selected = await gameRef.transaction((current) => {
      if (!current && !seededFromServerSnapshot) {
        current = observed;
        seededFromServerSnapshot = true;
      }
      if (!current || current.gameType !== 'ladder' || current.status !== 'active' || !Number.isFinite(Number(current.expiresAt)) || Number(current.expiresAt) <= now()
        || current.gameId !== gameId || current.finishClaim || !Array.isArray(current.players) || participantIndex >= current.players.length) return;
      return { ...current, selectedLane: participantIndex, selectedBy: p.uid, selectedAt: now() };
    });
    if (!selected.committed) {
      const latestSnapshot = await gameRef.get();
      return { miniGame: latestSnapshot.val(), stale: true };
    }
    return { miniGame: selected.snapshot.val() };
  }
  if (action === 'finish' || action === 'clear') {
    const timelineRef = db().ref(`${ROOT}/chat/${roomId}/streamerTimeline`);
    const candidateMessageId = timelineRef.push().key;
    const candidateFinishedAt = now();
    const isActiveLadder = (game) => !!game && game.gameType === 'ladder' && game.status === 'active'
      && Number.isFinite(Number(game.expiresAt)) && Number(game.expiresAt) > now()
      && Array.isArray(game.players) && Array.isArray(game.outcomes) && Array.isArray(game.rungs);
    let observed = (await gameRef.get()).val();
    if (!isActiveLadder(observed)) return { miniGame: null, stale: true };
    const expectedGameId = String(observed.gameId || '');
    if (!/^[a-f0-9]{24}$/.test(expectedGameId)) {
      throw new HttpsError('failed-precondition', '사다리 게임 식별자를 확인할 수 없습니다. 다시 불러와 주세요.');
    }
    let game = null;
    let finished = null;
    let transactionRuns = 0;
    let transactionAbortReason = '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let seededFromServerSnapshot = false;
      finished = await gameRef.transaction((current) => {
        transactionRuns += 1;
        if (!current && !seededFromServerSnapshot) {
          current = observed;
          seededFromServerSnapshot = true;
        }
        if (!current) { transactionAbortReason = 'missing'; return; }
        if (current.gameType !== 'ladder') { transactionAbortReason = 'wrong-game-type'; return; }
        if (current.status !== 'active') { transactionAbortReason = 'not-active'; return; }
        if (!Number.isFinite(Number(current.expiresAt)) || Number(current.expiresAt) <= now()) {
          transactionAbortReason = 'expired';
          return;
        }
        if (!Array.isArray(current.players) || !Array.isArray(current.outcomes) || !Array.isArray(current.rungs)) {
          transactionAbortReason = 'invalid-game-data';
          return;
        }
        if (String(current.gameId || '') !== expectedGameId) { transactionAbortReason = 'game-changed'; return; }
        if (current.finishClaim && current.finishClaim.messageId && current.finishClaim.text) return current;
        return {
          ...current,
          finishClaim: {
            messageId: candidateMessageId,
            createdAt: candidateFinishedAt,
            text: ladderResultText(current),
          },
        };
      });
      if (finished.committed) {
        game = finished.snapshot.val() || null;
        break;
      }

      observed = (await gameRef.get()).val();
      if (!isActiveLadder(observed) || String(observed.gameId || '') !== expectedGameId) {
        return { miniGame: isActiveLadder(observed) ? observed : null, stale: true };
      }
      if (observed.finishClaim && observed.finishClaim.messageId && observed.finishClaim.text) {
        game = observed;
        break;
      }
    }
    if (!game) {
      logger.warn('미니게임 종료 트랜잭션 재시도 후에도 확정되지 않았습니다.', {
        roomId,
        gameId: expectedGameId,
        transactionRuns,
        transactionAbortReason,
        committed: !!(finished && finished.committed),
        observedStatus: observed && observed.status,
        observedGameType: observed && observed.gameType,
        observedGameId: observed && observed.gameId,
        observedExpiresAt: observed && observed.expiresAt,
        hasFinishClaim: !!(observed && observed.finishClaim),
      });
      return { miniGame: isActiveLadder(observed) ? observed : null, stale: true };
    }
    const claim = game.finishClaim || {};
    if (!/^[A-Za-z0-9_-]{20}$/.test(String(claim.messageId || '')) || typeof claim.text !== 'string') {
      throw new HttpsError('failed-precondition', '사다리 결과를 확인할 수 없습니다. 다시 시도해 주세요.');
    }
    const message = {
      id: claim.messageId,
      roomId,
      senderUid: p.uid,
      senderRole: 'streamer',
      senderName: String(meta.streamerNickname || (meta.roomType === 'admin' ? '관리자' : '스트리머')).slice(0, 30),
      senderAvatarUrl: String(meta.streamerAvatarUrl || ''),
      createdAt: Number(claim.createdAt) || now(),
      recipientUid: null,
      kind: 'text',
      text: claim.text,
      scope: 'broadcast',
      miniGameResult: true,
    };
    await db().ref().update({
      [`${ROOT}/chat/${roomId}/streamerTimeline/${message.id}`]: message,
      [`${ROOT}/chat/${roomId}/broadcast/${message.id}`]: message,
      [`${ROOT}/rooms/${roomId}/meta/miniGame`]: null,
    });
    return { miniGame: null, message };
  }
  if (data.gameType !== 'ladder' || !Array.isArray(data.players) || !Array.isArray(data.outcomes)) {
    throw new HttpsError('invalid-argument', '사다리 게임 정보를 확인해 주세요.');
  }
  const players = data.players.map((value) => safeText(value, 24, true));
  const outcomes = data.outcomes.map((value) => safeText(value, 24, true));
  if (players.length < 2 || players.length > LADDER_PLAYER_LIMIT || outcomes.length !== players.length) {
    throw new HttpsError('invalid-argument', '참가자와 결과는 2~8개로 같은 수만큼 입력해 주세요.');
  }
  if (new Set(players.map((name) => name.toLocaleLowerCase('ko-KR'))).size !== players.length) {
    throw new HttpsError('invalid-argument', '참가자 이름은 서로 다르게 입력해 주세요.');
  }
  const createdAt = now();
  const miniGame = {
    gameId: crypto.randomBytes(12).toString('hex'),
    gameType: 'ladder',
    status: 'active',
    players,
    outcomes,
    rungs: createLadderRungs(players.length),
    selectedLane: -1,
    createdBy: p.uid,
    createdByName: String(meta.streamerNickname || '방 소유자').slice(0, 30),
    createdAt,
    expiresAt: createdAt + CHAT_RETENTION,
  };
  const started = await gameRef.transaction((current) => {
    if (isRenderableActiveLadder(current, createdAt)) return;
    return miniGame;
  });
  if (!started.committed) throw new HttpsError('already-exists', '이 채팅방에서 진행 중인 미니게임이 있습니다.');
  return { miniGame: started.snapshot.val() };
});

const WATCH_PARTY_SOOP_PARAMS = new Set([
  'isAfreeca', 'szBjId', 'nStationNo', 'nBbsNo', 'nTitleNo', 'szCategory', 'szPart', 'type', 'szSysType',
]);

function parseWatchPartySeconds(value) {
  const raw = String(value || '').trim();
  if (!raw) return 0;
  if (/^\d{1,7}$/.test(raw)) return Number(raw);
  const match = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i);
  if (!match || !match.slice(1).some(Boolean)) return null;
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

function parseWatchPartyVideo(value) {
  let url;
  try { url = new URL(value); } catch (_) { throw new HttpsError('invalid-argument', '영상 링크를 확인해 주세요.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 2048) {
    throw new HttpsError('invalid-argument', 'HTTPS 영상 링크만 사용할 수 있습니다.');
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (['youtube.com', 'm.youtube.com', 'youtube-nocookie.com', 'youtu.be'].includes(host)) {
    let videoId = '';
    if (host === 'youtu.be') videoId = url.pathname.split('/').filter(Boolean)[0] || '';
    else if (url.pathname === '/watch') videoId = url.searchParams.get('v') || '';
    else videoId = url.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})(?:\/|$)/)?.[1] || '';
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new HttpsError('invalid-argument', 'YouTube 영상 링크를 확인해 주세요.');
    const rawStart = url.searchParams.get('start') || url.searchParams.get('t') || '';
    const baseSecond = parseWatchPartySeconds(rawStart);
    if (baseSecond == null || baseSecond > 86400) throw new HttpsError('invalid-argument', 'YouTube 시작 위치가 올바르지 않습니다.');
    return { provider: 'youtube', videoId, baseSecond, url: `https://www.youtube.com/watch?v=${videoId}${baseSecond ? `&t=${baseSecond}s` : ''}` };
  }
  if (host === 'vod.sooplive.com') {
    const clipId = url.pathname.match(/^\/player\/(\d{1,20})(?:\/embed)?\/?$/)?.[1] || '';
    if (!clipId) throw new HttpsError('invalid-argument', 'SOOP VOD 또는 클립 링크를 확인해 주세요.');
    const rawStart = url.searchParams.get('change_second');
    const baseSecond = rawStart == null || rawStart === '' ? 0 : (/^\d{1,7}$/.test(rawStart) ? Number(rawStart) : null);
    if (baseSecond == null || baseSecond > 86400) throw new HttpsError('invalid-argument', 'SOOP 영상 시작 위치가 올바르지 않습니다.');
    const embedParams = {};
    for (const name of WATCH_PARTY_SOOP_PARAMS) {
      const paramValue = url.searchParams.get(name);
      if (paramValue && paramValue.length <= 160 && /^[A-Za-z0-9_.-]+$/.test(paramValue)) embedParams[name] = paramValue;
    }
    return { provider: 'soop-vod', videoId: clipId, baseSecond, embedParams, url: `https://vod.sooplive.com/player/${clipId}${baseSecond ? `?change_second=${baseSecond}` : ''}` };
  }
  throw new HttpsError('invalid-argument', 'YouTube 또는 SOOP VOD·클립 링크만 같이볼 수 있습니다.');
}

const messengerWatchPartyUpdate = onCall({ maxInstances: 20 }, async (request) => {
  const data = request.data || {};
  const roomId = String(data.roomId || '');
  const action = String(data.action || '');
  const principal = await requireRoomPrincipal(request, roomId);
  if (!/^[a-z0-9]{2,30}$/.test(roomId) || !['create', 'approve', 'cancel', 'finish', 'complete', 'sync'].includes(action)) {
    throw new HttpsError('invalid-argument', '채팅방 또는 같이보기 요청 정보가 올바르지 않습니다.');
  }
  const { meta, isOwner, member } = await requireRoomMember(principal, roomId);
  const canManageRoom = isOwner || (principal.admin && meta.roomType === 'admin');
  const partyRef = roomRef(roomId).child('meta/watchParty');
  if (action === 'sync') return { watchParty: (await partyRef.get()).val() || null };

  if (action === 'create') {
    const video = parseWatchPartyVideo(safeText(String(data.url || ''), 2048, true));
    // Older open pages may still submit minutes; convert those while new pages submit seconds.
    const delaySeconds = data.startDelaySeconds == null
      ? Number(data.startDelayMinutes) * 60
      : Number(data.startDelaySeconds);
    const durationSeconds = Number(data.durationSeconds || 0);
    if (!Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > 7200 || delaySeconds % 10 !== 0
      || !Number.isInteger(durationSeconds) || durationSeconds < 0 || durationSeconds > 43200
      || (durationSeconds > 0 && durationSeconds <= video.baseSecond)) {
      throw new HttpsError('invalid-argument', '시작 대기 시간은 10초 단위로, 영상 길이는 시작 위치보다 길게 입력해 주세요.');
    }
    const title = safeText(String(data.title || (video.provider === 'youtube' ? 'YouTube 영상' : 'SOOP VOD · 클립')), 160, true);
    const createdAt = now();
    const approvalStatus = canManageRoom ? 'approved' : 'pending';
    const startsAt = canManageRoom ? createdAt + Math.max(2500, delaySeconds * 1000) : 0;
    const endsAt = canManageRoom && durationSeconds ? startsAt + (durationSeconds - video.baseSecond) * 1000 : 0;
    const candidate = {
      partyId: crypto.randomBytes(12).toString('hex'), status: canManageRoom ? 'scheduled' : 'pending',
      approvalStatus,
      createdByUid: principal.uid,
      createdByName: String(canManageRoom ? meta.streamerNickname || (meta.roomType === 'admin' ? '관리자' : '스트리머') : member && member.profile && member.profile.nickname || principal.profile && principal.profile.nickname || '참여자').slice(0, 30),
      video: { ...video, title, durationSeconds }, startsAt, endsAt, requestedDelaySeconds: delaySeconds,
      ...(canManageRoom ? { approvedAt: createdAt } : {}), createdAt, updatedAt: createdAt,
    };
    const result = await partyRef.transaction((current) => {
      const active = current && ['pending', 'scheduled', 'active'].includes(current.status)
        && !(Number(current.endsAt) > 0 && Number(current.endsAt) <= createdAt);
      if (active) return;
      return candidate;
    });
    if (!result.committed) throw new HttpsError('already-exists', '이 채팅방에서 이미 같이보기가 예약되었거나 진행 중입니다.');
    return { watchParty: result.snapshot.val() };
  }

  const partyId = String(data.partyId || '');
  if (!/^[a-f0-9]{24}$/.test(partyId)) throw new HttpsError('invalid-argument', '같이보기 식별자를 확인해 주세요.');
  const before = (await partyRef.get()).val();
  if (!before || before.partyId !== partyId || !['pending', 'scheduled', 'active'].includes(before.status)) {
    return { watchParty: before || null, stale: true };
  }
  const approvalStatus = before.approvalStatus || 'approved';
  if (action === 'approve') {
    if (!canManageRoom) throw new HttpsError('permission-denied', '스트리머 또는 관리자 방 관리자만 같이보기 신청을 승인할 수 있습니다.');
    if (approvalStatus !== 'pending' || before.status !== 'pending') {
      return { watchParty: before, stale: true };
    }
    const at = now();
    const delaySeconds = Number(before.requestedDelaySeconds);
    const durationSeconds = Number(before.video && before.video.durationSeconds) || 0;
    if (!Number.isInteger(delaySeconds) || delaySeconds < 0 || delaySeconds > 7200 || delaySeconds % 10 !== 0) {
      throw new HttpsError('failed-precondition', '신청된 시작 대기 시간이 올바르지 않아 승인할 수 없습니다.');
    }
    const startsAt = at + Math.max(2500, delaySeconds * 1000);
    const endsAt = durationSeconds ? startsAt + (durationSeconds - Number(before.video.baseSecond || 0)) * 1000 : 0;
    const changed = await partyRef.transaction((current) => {
      const latest = current || before;
      if (!latest || latest.partyId !== partyId || latest.status !== 'pending'
        || (latest.approvalStatus || 'approved') !== 'pending') return;
      return { ...latest, status: 'scheduled', approvalStatus: 'approved', approvedAt: at, startsAt, endsAt, updatedAt: at };
    });
    return { watchParty: changed.snapshot.val() || before, stale: !changed.committed };
  }
  const mayManage = canManageRoom || before.createdByUid === principal.uid;
  if (action === 'cancel' && !mayManage) throw new HttpsError('permission-denied', '방 소유자 또는 예약한 사용자만 같이보기를 취소할 수 있습니다.');
  if (action === 'finish' && !mayManage) throw new HttpsError('permission-denied', '방 소유자 또는 예약한 사용자만 같이보기를 마칠 수 있습니다.');
  if (approvalStatus === 'pending' && ['finish', 'complete'].includes(action)) {
    throw new HttpsError('failed-precondition', '스트리머가 신청을 승인한 뒤에 이용할 수 있습니다.');
  }
  const at = now();
  if (action === 'cancel' && approvalStatus !== 'pending' && at >= Number(before.startsAt)) throw new HttpsError('failed-precondition', '재생이 시작되기 전에만 같이보기를 취소할 수 있습니다.');
  if (action === 'finish' && at < Number(before.startsAt)) throw new HttpsError('failed-precondition', '재생이 시작된 뒤에 같이보기를 마칠 수 있습니다.');
  if (action === 'complete' && (!Number(before.endsAt) || at < Number(before.endsAt) - 5000)) {
    throw new HttpsError('failed-precondition', '등록된 영상 길이만큼 재생한 뒤 종료할 수 있습니다.');
  }
  const nextStatus = action === 'cancel' ? 'cancelled' : 'ended';
  const changed = await partyRef.transaction((current) => {
    // A transaction can start with an empty local cache even after the preceding get().
    // Use that verified read as its candidate; RTDB retries with the server value if it changed.
    const latest = current || before;
    if (!latest || latest.partyId !== partyId || !['pending', 'scheduled', 'active'].includes(latest.status)) return;
    if (action === 'cancel' && (latest.approvalStatus || 'approved') !== 'pending' && at >= Number(latest.startsAt)) return;
    if (action === 'finish' && at < Number(latest.startsAt)) return;
    if (action === 'complete' && (!Number(latest.endsAt) || at < Number(latest.endsAt) - 5000)) return;
    return { ...latest, status: nextStatus, updatedAt: at, ...(nextStatus === 'ended' ? { endedAt: at } : { cancelledAt: at, cancelledByUid: principal.uid }) };
  });
  return { watchParty: changed.snapshot.val() || before, stale: !changed.committed };
});

async function galleryImageForChat(roomId, imageId) {
  const rawMeta = (await roomRef(roomId).child('meta').get()).val() || {};
  const meta = await ensureGalleryLink(roomId, rawMeta);
  if (!meta.galleryStreamerId) throw new HttpsError('failed-precondition', '인증된 스트리머 닉네임과 갤러리 스트리머를 연결할 수 없습니다. 갤러리의 스트리머 이름을 확인해 주세요.');
  const imageSnap = await sharedDb().ref(`gallery/imagesPublic/${imageId}`).get();
  if (!imageSnap.exists()) throw new HttpsError('not-found', '갤러리 이미지가 없거나 삭제되었습니다.');
  const image = imageSnap.val() || {};
  if (String(image.streamerId || '') !== String(meta.galleryStreamerId || '')) throw new HttpsError('permission-denied', '이 채팅방 스트리머의 갤러리 이미지만 보낼 수 있습니다.');
  const [firstUpload, unlockedUntil] = await Promise.all([
    sharedDb().ref(`gallery/streamerFirstUpload/${meta.galleryStreamerId}`).get(),
    sharedDb().ref(`gallery/streamerUnlockedUntil/${meta.galleryStreamerId}`).get(),
  ]);
  const first = Number(firstUpload.val()) || 0;
  const until = Number(unlockedUntil.val()) || 0;
  const unlocked = (first > 0 && now() < first + 30 * 24 * 60 * 60 * 1000) || (until > 0 && now() < until);
  if (!unlocked) throw new HttpsError('failed-precondition', '갤러리 열람 기간이 끝났습니다. 먼저 스트리머 갤러리에서 해금해 주세요.');
  return { imageId, streamerId: image.streamerId, thumbUrl: image.thumbUrl || '', imageUrl: image.imageUrl || '', width: image.width || null, height: image.height || null, createdAt: image.createdAt || 0 };
}

const messengerGetGalleryImages = onCall(async (request) => {
  const roomId = String((request.data || {}).roomId || '');
  const p = await requireRoomPrincipal(request, roomId);
  const { meta: rawMeta } = await requireRoomMember(p, roomId);
  const meta = await ensureGalleryLink(roomId, rawMeta);
  if (!meta.galleryStreamerId) return { locked: false, linked: false, streamerId: '', images: [] };
  const [firstUpload, unlockedUntil] = await Promise.all([
    sharedDb().ref(`gallery/streamerFirstUpload/${meta.galleryStreamerId}`).get(),
    sharedDb().ref(`gallery/streamerUnlockedUntil/${meta.galleryStreamerId}`).get(),
  ]);
  const first = Number(firstUpload.val()) || 0;
  const until = Number(unlockedUntil.val()) || 0;
  const unlocked = (first > 0 && now() < first + 30 * 24 * 60 * 60 * 1000) || (until > 0 && now() < until);
  if (!unlocked) {
    const hasImages = (await sharedDb().ref('gallery/imagesPublic').orderByChild('streamerId').equalTo(meta.galleryStreamerId).limitToFirst(1).get()).exists();
    if (hasImages) return { locked: true, linked: true, streamerId: meta.galleryStreamerId, images: [] };
    return { locked: false, linked: true, streamerId: meta.galleryStreamerId, images: [] };
  }
  const snap = await sharedDb().ref('gallery/imagesPublic').orderByChild('streamerId').equalTo(meta.galleryStreamerId).limitToLast(100).get();
  const images = [];
  snap.forEach((child) => { const image = child.val() || {}; images.push({ imageId: child.key, thumbUrl: image.thumbUrl || '', imageUrl: image.imageUrl || '', createdAt: image.createdAt || 0, width: image.width || null, height: image.height || null }); });
  images.sort((a, b) => b.createdAt - a.createdAt);
  return { locked: false, linked: true, streamerId: meta.galleryStreamerId, images };
});

const messengerGetGalleryImage = onCall(async (request) => {
  const { roomId, imageId } = request.data || {};
  const p = await requireRoomPrincipal(request, roomId);
  await requireRoomMember(p, String(roomId || ''));
  return await galleryImageForChat(String(roomId), String(imageId || ''));
});

const messengerRequestRoomselfUpload = onCall({ secrets: [roomselfAccessKeyId, roomselfSecretAccessKey], maxInstances: 20 }, async (request) => {
  const { roomId, recipientUid, contentType, size } = request.data || {};
  const room = String(roomId || ''); const recipient = String(recipientUid || '');
  const p = await requireRoomPrincipal(request, room);
  const { meta, isOwner } = await requireRoomMember(p, room);
  if (!isOwner) throw new HttpsError('permission-denied', '스트리머만 방셀 이미지를 보낼 수 있습니다.');
  const member = await roomRef(room).child(`members/${recipient}`).get();
  if (!member.exists() || member.val().status !== 'active') throw new HttpsError('failed-precondition', '참여 중인 팬에게만 방셀을 보낼 수 있습니다.');
  const mimeExt = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
  if (!mimeExt[contentType] || !Number.isInteger(size) || size < 1 || size > ROOMSELF_MAX_BYTES) throw new HttpsError('invalid-argument', 'JPG, PNG, WebP, GIF 형식의 15MB 이하 이미지를 선택해 주세요.');
  const uploadLimitRef = db().ref(`${ROOT}/rateLimits/roomselfUploads/${p.uid}`);
  const uploadGate = await uploadLimitRef.transaction((current) => {
    const t = now();
    const lastRequestedAt = Number(current && current.lastRequestedAt) || 0;
    if (lastRequestedAt && t - lastRequestedAt < ROOMSELF_UPLOAD_WINDOW) return;
    return { lastRequestedAt: t };
  });
  if (!uploadGate.committed) throw new HttpsError('resource-exhausted', '방셀 이미지는 10초에 한 장씩 업로드할 수 있습니다. 잠시 후 다시 시도해 주세요.');
  const id = crypto.randomUUID().replaceAll('-', ''); const key = roomselfKey(id, mimeExt[contentType]); const at = now();
  const record = { id, roomId: room, ownerUid: p.uid, recipientUid: recipient, uploaderUid: p.uid, key, contentType, size, status: 'upload_issued', createdAt: at, expiresAt: at + ROOMSELF_UPLOAD_FINALIZE_TTL };
  await db().ref().update({ [`${ROOT}/privateImages/${id}`]: record, [`${ROOT}/privateImageDays/${roomselfDateShard(at)}/${id}`]: true });
  const uploadUrl = await getSignedUrl(roomselfS3(), new PutObjectCommand({ Bucket: ROOMSELF_BUCKET, Key: key, ContentType: contentType, ContentLength: size }), { expiresIn: 300 });
  return { imageId: id, uploadUrl, expiresAt: at + 5 * 60 * 1000, streamerName: meta.streamerNickname || '' };
});

const messengerFinalizeRoomselfUpload = onCall({ secrets: [roomselfAccessKeyId, roomselfSecretAccessKey], maxInstances: 20 }, async (request) => {
  const p = await getPrincipal(request);
  const imageId = String((request.data || {}).imageId || '');
  if (!/^[a-f0-9]{32}$/.test(imageId)) throw new HttpsError('invalid-argument', '이미지 정보가 올바르지 않습니다.');
  const ref = db().ref(`${ROOT}/privateImages/${imageId}`); const snap = await ref.get(); const record = snap.val() || {};
  await requireRoomPrincipal(request, record.roomId);
  if (!snap.exists() || record.uploaderUid !== p.uid || record.status !== 'upload_issued' || now() > Number(record.expiresAt)) throw new HttpsError('permission-denied', '이미지 업로드를 확인할 수 없습니다. 다시 시도해 주세요.');
  const head = await roomselfS3().send(new HeadObjectCommand({ Bucket: ROOMSELF_BUCKET, Key: record.key }));
  if (Number(head.ContentLength) !== Number(record.size) || head.ContentType !== record.contentType || Number(head.ContentLength) > ROOMSELF_MAX_BYTES) throw new HttpsError('failed-precondition', '업로드한 이미지 정보를 확인할 수 없습니다.');
  const object = await roomselfS3().send(new GetObjectCommand({ Bucket: ROOMSELF_BUCKET, Key: record.key, Range: 'bytes=0-11' }));
  const bytes = Buffer.from(await object.Body.transformToByteArray());
  if (!roomselfBytesMatchType(bytes, record.contentType)) {
    await roomselfS3().send(new DeleteObjectCommand({ Bucket: ROOMSELF_BUCKET, Key: record.key }));
    throw new HttpsError('invalid-argument', '선택한 파일이 올바른 이미지가 아닙니다.');
  }
  await ref.update({ status: 'uploaded', uploadedAt: now() });
  return { imageId, ready: true };
});

const messengerGetRoomselfImage = onCall({ secrets: [roomselfAccessKeyId, roomselfSecretAccessKey], maxInstances: 20 }, async (request) => {
  const { roomId, imageId } = request.data || {}; const room = String(roomId || ''); const id = String(imageId || '');
  const p = await requireRoomPrincipal(request, room);
  const { meta, isOwner, member } = await requireRoomMember(p, room);
  const snap = await db().ref(`${ROOT}/privateImages/${id}`).get(); const record = snap.val() || {};
  const allowed = isOwner && record.ownerUid === p.uid || record.recipientUid === p.uid && Number(member && member.joinedAt || 0) <= Number(record.sentAt || 0);
  if (!snap.exists() || record.roomId !== room || !allowed || record.status !== 'sent') throw new HttpsError('permission-denied', '이 비공개 이미지를 볼 권한이 없습니다.');
  const recipientMember = (await roomRef(room).child(`members/${record.recipientUid}`).get()).val() || {};
  if (recipientMember.status !== 'active') throw new HttpsError('permission-denied', '대화가 중단된 팬의 이미지는 볼 수 없습니다.');
  const msg = (await db().ref(`${ROOT}/chat/${room}/streamerTimeline/${record.messageId}`).get()).val() || {};
  const messageMatches = msg.kind === 'roomself' && msg.roomselfImageId === id && msg.recipientUid === record.recipientUid && msg.senderUid === record.ownerUid;
  if (!messageMatches && record.archived !== true) throw new HttpsError('not-found', '이미지를 찾을 수 없습니다.');
  const object = await roomselfS3().send(new GetObjectCommand({ Bucket: ROOMSELF_BUCKET, Key: record.key }));
  const bytes = await object.Body.transformToByteArray();
  if (bytes.byteLength > ROOMSELF_MAX_BYTES) throw new HttpsError('resource-exhausted', '이미지 용량 제한을 초과했습니다.');
  return { contentType: record.contentType, data: Buffer.from(bytes).toString('base64'), streamerName: meta.streamerNickname || '' };
});

const messengerLoadArchivedMessages = onCall({ secrets: [roomselfAccessKeyId, roomselfSecretAccessKey], maxInstances: 20, timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
  const data = request.data || {};
  const roomId = String(data.roomId || '');
  const principal = await requireRoomPrincipal(request, roomId);
  const { isOwner, meta } = await requireRoomMember(principal, roomId);
  const cursors = data.cursors && typeof data.cursors === 'object' ? data.cursors : {};
  const limits = data.limits && typeof data.limits === 'object' ? data.limits : {};
  const streams = isOwner
    ? [{ key: 'owner', scopeKey: 'owner', uid: '' }]
    : [
      { key: 'private', scopeKey: archivePrivateScope(principal.uid), uid: principal.uid },
      { key: 'broadcast', scopeKey: 'broadcast', uid: '' },
    ];
  const s3 = roomselfS3();
  const objectCache = new Map();
  const pages = {};
  const generation = /^[a-f0-9]{32}$/.test(String(meta.archiveGeneration || ''))
    ? String(meta.archiveGeneration)
    : await ensureMessageArchiveGeneration(roomId);
  await Promise.all(streams.filter((stream) => Object.prototype.hasOwnProperty.call(cursors, stream.key)).map(async (stream) => {
    pages[stream.key] = await loadArchivedMessagePage(roomId, generation, stream.scopeKey, stream.uid, cursors[stream.key], s3, objectCache, limits[stream.key]);
  }));
  return { pages };
});

const messengerGetLinkPreview = onCall({ maxInstances: 10 }, async (request) => {
  const data = request.data || {};
  const roomId = String(data.roomId || '');
  const principal = await requireRoomPrincipal(request, roomId);
  await requireRoomMember(principal, roomId);
  const url = safeText(String(data.url || ''), 2048, true);
  return getLinkPreview(url);
});

async function fetchSoopStationStatus(soopId) {
  const response = await fetch(`https://chapi.sooplive.com/api/${encodeURIComponent(soopId)}/station`, {
    headers: {
      accept: 'application/json',
      origin: 'https://www.sooplive.com',
      referer: `https://www.sooplive.com/station/${encodeURIComponent(soopId)}`,
      'user-agent': 'Mozilla/5.0',
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`SOOP station API returned ${response.status}`);
  const payload = await response.json();
  const stationId = payload && payload.station && payload.station.user_id;
  if (typeof stationId !== 'string' || stationId.toLowerCase() !== soopId) throw new Error('SOOP station response did not match the requested streamer');

  const broad = payload && payload.broad && typeof payload.broad === 'object' ? payload.broad : null;
  if (!broad) return { isLive: false };
  const broadcastId = String(broad.broad_no || '').trim();
  if (!/^\d{1,20}$/.test(broadcastId) || broadcastId === '0') throw new Error('SOOP broadcast ID is invalid');
  return {
    isLive: true,
    broadcastId,
    title: String(broad.broad_title || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    streamUrl: `https://play.sooplive.com/${encodeURIComponent(soopId)}/${encodeURIComponent(broadcastId)}`,
  };
}

function broadcastHistoryMessageId(roomId, broadcastId) {
  return crypto.createHash('sha256').update(`${roomId}\0${broadcastId}`).digest('base64url').slice(0, 20);
}

function parseSoopVodDate(value) {
  const match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (match) {
    const [, year, month, day, hour, minute, second = '0'] = match;
    return Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)) - 9 * 60 * 60 * 1000;
  }
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeBroadcastVod(record) {
  const id = String(record && record.title_no || '');
  if (!/^\d{1,20}$/.test(id)) return null;
  const thumbnailValue = String(record && record.ucc && record.ucc.thumb || '');
  let thumbnailUrl = '';
  try {
    const parsed = new URL(thumbnailValue.startsWith('//') ? `https:${thumbnailValue}` : thumbnailValue);
    if (parsed.protocol === 'https:' && (parsed.hostname === 'sooplive.com' || parsed.hostname.endsWith('.sooplive.com'))) thumbnailUrl = parsed.href;
  } catch (_) { /* 잘못된 썸네일은 저장하지 않습니다. */ }
  return {
    id,
    title: String(record.title_name || '제목 없는 다시보기').replace(/\s+/g, ' ').trim().slice(0, 180),
    createdAt: String(record.reg_date || '').slice(0, 32),
    publishedAt: parseSoopVodDate(record.reg_date),
    durationMs: Math.max(0, Number(record.ucc && record.ucc.total_file_duration) || 0),
    thumbnailUrl,
    url: `https://vod.sooplive.com/player/${id}`,
  };
}

async function fetchRecentSoopVods(soopId) {
  const endpoint = new URL(`https://chapi.sooplive.com/api/${encodeURIComponent(soopId)}/vods/review`);
  endpoint.searchParams.set('orderby', 'reg_date');
  endpoint.searchParams.set('page', '1');
  endpoint.searchParams.set('field', 'title,contents,user_nick,user_id');
  endpoint.searchParams.set('per_page', '30');
  const response = await fetch(endpoint, {
    headers: { accept: 'application/json', 'user-agent': 'StreamerMessenger/1.0' },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`SOOP VOD API returned ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload && payload.data)) throw new Error('SOOP VOD response did not contain a record list');
  return payload.data.map(normalizeBroadcastVod).filter((vod) => vod && vod.publishedAt);
}

async function getBroadcastHistoryMemberCount(roomId, room) {
  const projectedCount = Number(room && room.memberCount);
  if (room && room.visibility !== 'private' && Number.isFinite(projectedCount) && projectedCount >= 0) {
    return Math.floor(projectedCount);
  }

  // Private room projections intentionally omit memberCount. Read the authoritative
  // meta value maintained by the approval/block/removal writers in that case.
  const count = Number((await roomRef(roomId).child('meta/memberCount').get()).val());
  return Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0;
}

function matchBroadcastVod(vods, broadcast) {
  const startedAt = Number(broadcast.startedAt) || 0;
  const endedAt = Number(broadcast.endedAt) || 0;
  const expectedDuration = Math.max(0, endedAt - startedAt);
  const normalizeTitle = (value) => String(value || '').toLocaleLowerCase().replace(/[\s.,!?()[\]{}:;'"“”‘’·|/\\-]+/g, '');
  const title = normalizeTitle(broadcast.title);
  const candidates = (vods || []).map((vod) => {
    if (vod.publishedAt < startedAt - 30 * 60 * 1000 || vod.publishedAt > endedAt + 36 * 60 * 60 * 1000) return null;
    const titleMatches = !!title && normalizeTitle(vod.title) === title;
    const distanceFromEnd = Math.abs(vod.publishedAt - endedAt);
    if (!titleMatches && distanceFromEnd > 60 * 60 * 1000) return null;
    if (expectedDuration && vod.durationMs && vod.durationMs < expectedDuration * 0.65) return null;
    if (!titleMatches && (!expectedDuration || !vod.durationMs)) return null;
    const durationDifference = expectedDuration && vod.durationMs ? Math.abs(vod.durationMs - expectedDuration) : 0;
    return { vod, score: (titleMatches ? 0 : 1000000000000) + distanceFromEnd + durationDifference * 0.05 };
  }).filter(Boolean).sort((a, b) => a.score - b.score);
  return candidates.length ? candidates[0].vod : null;
}

function broadcastHistoryMessagePath(roomId, messageId) {
  return `${ROOT}/chat/${roomId}/streamerTimeline/${messageId}`;
}

function addBroadcastHistoryMessageUpdates(updates, roomId, message) {
  updates[broadcastHistoryMessagePath(roomId, message.id)] = message;
  updates[`${ROOT}/chat/${roomId}/broadcast/${message.id}`] = message;
}

function broadcastHistoryViewerStatsCacheRef(soopId, vodId) {
  return sharedDb().ref(`streamerFanPageViewerStatsCache/${soopId}/${vodId}`);
}

function broadcastHistoryViewerStatsTaskQueue() {
  return getFunctions().taskQueue(BROADCAST_HISTORY_VIEWER_ANALYSIS_TASK_FUNCTION);
}

function reusableBroadcastViewerStats(record, soopId, vodId) {
  if (!record || record.status !== 'completed' || Number(record.schemaVersion) !== 1) return null;
  const stats = record.stats;
  const validPoint = (point) => point && Number.isFinite(Number(point.second)) && Number(point.second) >= 0
    && Number.isFinite(Number(point.viewers)) && Number(point.viewers) >= 0;
  if (!stats || String(stats.streamerId || '').trim().toLowerCase() !== soopId
    || String(stats.vodId || '').trim() !== vodId
    || !validPoint(stats.highest) || !validPoint(stats.lowest)) return null;
  return {
    highest: { second: Math.floor(Number(stats.highest.second)), viewers: Math.floor(Number(stats.highest.viewers)) },
    lowest: { second: Math.floor(Number(stats.lowest.second)), viewers: Math.floor(Number(stats.lowest.viewers)) },
    analyzedAt: Number(record.analyzedAt) || Number(stats.checkedAt) || 0,
  };
}

function broadcastHistoryViewerAnalysisTaskId(soopId, vodId, attempt) {
  const digest = crypto.createHash('sha256').update(`${soopId}\0${vodId}\0${attempt}`).digest('hex').slice(0, 48);
  return `bva-${digest}`;
}

async function enqueueBroadcastHistoryViewerAnalysis(soopId, vodId, attempt) {
  await broadcastHistoryViewerStatsTaskQueue().enqueue({ streamerId: soopId, vodId }, {
    id: broadcastHistoryViewerAnalysisTaskId(soopId, vodId, attempt),
    dispatchDeadlineSeconds: 120,
  });
}

function formatBroadcastHistoryElapsed(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return [hours, minutes, remainder].map((part) => String(part).padStart(2, '0')).join(':');
}

async function processPendingBroadcastViewerAnalysis(roomId, pending, state, updates, checkedAt) {
  const normalizedSoopId = String(pending.soopId || '').trim().toLowerCase();
  const vodId = String(pending.vodId || '').trim();
  if (!/^[a-z0-9]{2,20}$/.test(normalizedSoopId) || !/^\d{1,20}$/.test(vodId)) {
    delete state.pendingViewerAnalyses[pending.broadcastId];
    return;
  }

  const messagePath = broadcastHistoryMessagePath(roomId, pending.messageId);
  const messageSnapshot = await db().ref(messagePath).get();
  const current = updates[messagePath] || messageSnapshot.val();
  if (!current || current.broadcastStatus !== 'ended' || !current.vod || String(current.vod.id) !== vodId) {
    delete state.pendingViewerAnalyses[pending.broadcastId];
    return;
  }

  const cacheSnapshot = await broadcastHistoryViewerStatsCacheRef(normalizedSoopId, vodId).get();
  const stats = reusableBroadcastViewerStats(cacheSnapshot.val(), normalizedSoopId, vodId);
  if (stats) {
    const updated = {
      ...current,
      viewerAnalysis: { status: 'ready', ...stats },
      updatedAt: checkedAt,
    };
    addBroadcastHistoryMessageUpdates(updates, roomId, updated);
    delete state.pendingViewerAnalyses[pending.broadcastId];
    return;
  }

  if (Number(pending.nextCheckAt) > checkedAt) return;
  const attempt = Math.max(0, Number(pending.attempts) || 0);
  if (attempt >= BROADCAST_HISTORY_VIEWER_ANALYSIS_RETRY_AFTER_MS.length) {
    const updated = {
      ...current,
      viewerAnalysis: { status: 'unavailable', checkedAt },
      updatedAt: checkedAt,
    };
    addBroadcastHistoryMessageUpdates(updates, roomId, updated);
    delete state.pendingViewerAnalyses[pending.broadcastId];
    return;
  }

  const nextAttempt = attempt + 1;
  try {
    await enqueueBroadcastHistoryViewerAnalysis(normalizedSoopId, vodId, nextAttempt);
  } catch (error) {
    // A task with the same VOD/attempt ID may already be queued. That is safe:
    // the fanpage worker and its shared cache make duplicate work idempotent.
    if (!['functions/task-already-exists', 'functions/already-exists'].includes(error && error.code)) {
      logger.warn('Could not enqueue broadcast VOD viewer analysis', {
        roomId,
        soopId: normalizedSoopId,
        vodId,
        attempt: nextAttempt,
        message: String(error && error.message || error).slice(0, 120),
      });
    }
  }

  const updated = {
    ...current,
    viewerAnalysis: { status: 'pending' },
    updatedAt: checkedAt,
  };
  addBroadcastHistoryMessageUpdates(updates, roomId, updated);
  state.pendingViewerAnalyses[pending.broadcastId] = {
    ...pending,
    attempts: nextAttempt,
    nextCheckAt: checkedAt + BROADCAST_HISTORY_VIEWER_ANALYSIS_RETRY_AFTER_MS[attempt],
  };
}

async function endTrackedBroadcast(roomId, state, endedAt, updates) {
  const broadcastId = String(state.activeBroadcastId || '');
  const messageId = String(state.activeMessageId || '');
  if (!broadcastId || !messageId) return;
  const messageSnapshot = await db().ref(broadcastHistoryMessagePath(roomId, messageId)).get();
  const current = messageSnapshot.val() || {};
  const message = {
    ...current,
    id: messageId,
    roomId,
    senderUid: current.senderUid || state.activeSenderUid || 'streamer-messenger-system',
    senderRole: 'streamer',
    senderName: current.senderName || state.activeSenderName || '스트리머',
    senderAvatarUrl: current.senderAvatarUrl || state.activeSenderAvatarUrl || '',
    createdAt: endedAt,
    scope: 'broadcast',
    kind: 'streamer-broadcast',
    broadcastId,
    title: String(current.title || state.activeTitle || '제목 없는 방송'),
    streamUrl: String(current.streamUrl || state.activeStreamUrl || ''),
    startedAt: Number(current.startedAt) || Number(state.activeStartedAt) || endedAt,
    broadcastStatus: 'ended',
    endedAt,
    vodStatus: 'pending',
    updatedAt: endedAt,
  };
  addBroadcastHistoryMessageUpdates(updates, roomId, message);
  state.pendingVods = state.pendingVods || {};
  state.pendingVods[broadcastId] = {
    broadcastId,
    messageId,
    title: message.title,
    startedAt: message.startedAt,
    endedAt,
    lookupIndex: 0,
    nextLookupAt: endedAt + BROADCAST_HISTORY_VOD_RETRY_AFTER_MS[0],
    soopId: String(state.soopId || ''),
  };
  state.activeBroadcastId = '';
  state.activeMessageId = '';
  state.activeSenderUid = '';
  state.activeSenderName = '';
  state.activeSenderAvatarUrl = '';
  state.activeTitle = '';
  state.activeStreamUrl = '';
  state.activeStartedAt = 0;
}

async function startTrackedBroadcast(roomId, room, soopId, status, state, startedAt, updates) {
  const metadata = (await roomRef(roomId).child('meta').get()).val() || {};
  const ownerUid = String(metadata.ownerUid || '');
  if (!ownerUid) throw new Error('room owner is missing');
  const messageId = broadcastHistoryMessageId(roomId, status.broadcastId);
  const senderName = String(room.streamerNickname || metadata.streamerNickname || '스트리머').slice(0, 30);
  const message = {
    id: messageId,
    roomId,
    senderUid: ownerUid,
    senderRole: 'streamer',
    senderName,
    senderAvatarUrl: String(room.streamerAvatarUrl || metadata.streamerAvatarUrl || ''),
    createdAt: startedAt,
    scope: 'broadcast',
    kind: 'streamer-broadcast',
    broadcastId: status.broadcastId,
    title: String(status.title || '제목 없는 방송'),
    streamUrl: status.streamUrl,
    broadcastStatus: 'live',
    startedAt,
    vodStatus: 'not_applicable',
  };
  addBroadcastHistoryMessageUpdates(updates, roomId, message);
  state.activeBroadcastId = status.broadcastId;
  state.activeMessageId = messageId;
  state.activeSenderUid = ownerUid;
  state.activeSenderName = senderName;
  state.activeSenderAvatarUrl = message.senderAvatarUrl;
  state.activeTitle = message.title;
  state.activeStreamUrl = status.streamUrl;
  state.activeStartedAt = startedAt;
  state.soopId = soopId;
}

async function updatePendingBroadcastVod(roomId, pending, state, updates, checkedAt, getRecentVods = fetchRecentSoopVods) {
  const messageRef = db().ref(broadcastHistoryMessagePath(roomId, pending.messageId));
  const messageSnapshot = await messageRef.get();
  const current = messageSnapshot.val();
  if (!current || current.broadcastStatus !== 'ended') {
    delete state.pendingVods[pending.broadcastId];
    return;
  }

  let vods;
  try {
    vods = await getRecentVods(pending.soopId);
  } catch (error) {
    state.pendingVods[pending.broadcastId] = {
      ...pending,
      errorCount: (Number(pending.errorCount) || 0) + 1,
      nextLookupAt: checkedAt + 15 * 60 * 1000,
    };
    logger.warn('SOOP broadcast history VOD lookup failed', {
      roomId,
      soopId: pending.soopId,
      broadcastId: pending.broadcastId,
      message: String(error && error.message || error).slice(0, 120),
    });
    return;
  }

  const vod = matchBroadcastVod(vods, pending);
  if (vod) {
    const updated = {
      ...current,
      createdAt: checkedAt,
      vodStatus: 'ready',
      vod: {
        id: vod.id,
        title: vod.title,
        createdAt: vod.createdAt,
        durationMs: vod.durationMs,
        thumbnailUrl: vod.thumbnailUrl,
        url: vod.url,
      },
      viewerAnalysis: { status: 'pending' },
      updatedAt: checkedAt,
    };
    addBroadcastHistoryMessageUpdates(updates, roomId, updated);
    state.pendingViewerAnalyses = state.pendingViewerAnalyses || {};
    state.pendingViewerAnalyses[pending.broadcastId] = {
      broadcastId: pending.broadcastId,
      messageId: pending.messageId,
      soopId: pending.soopId,
      vodId: vod.id,
      attempts: 0,
      nextCheckAt: checkedAt,
      createdAt: checkedAt,
    };
    delete state.pendingVods[pending.broadcastId];
    return;
  }

  const nextLookupIndex = (Number(pending.lookupIndex) || 0) + 1;
  const nextDelay = BROADCAST_HISTORY_VOD_RETRY_AFTER_MS[nextLookupIndex];
  if (nextDelay) {
    state.pendingVods[pending.broadcastId] = { ...pending, lookupIndex: nextLookupIndex, nextLookupAt: pending.endedAt + nextDelay };
    return;
  }

  const updated = { ...current, createdAt: checkedAt, vodStatus: 'not_found', updatedAt: checkedAt };
  addBroadcastHistoryMessageUpdates(updates, roomId, updated);
  delete state.pendingVods[pending.broadcastId];
}

function broadcastHistoryMonitorRef(roomId) {
  return db().ref(`${ROOT}/broadcastMonitor/${roomId}`);
}

async function transactBroadcastHistoryMonitor(monitorRef, update, fallbackState) {
  const fallback = arguments.length >= 3 ? fallbackState : (await monitorRef.get()).val();
  return monitorRef.transaction((current) => update(current == null ? fallback : current));
}

function broadcastHistoryTaskQueue() {
  return getFunctions().taskQueue(BROADCAST_HISTORY_TASK_FUNCTION);
}

function broadcastHistoryTaskId(roomId, generation, dueAt) {
  const digest = crypto.createHash('sha256').update(`${roomId}\0${generation}\0${dueAt}`).digest('hex').slice(0, 48);
  return `bh-${digest}`;
}

function isBroadcastHistoryRoom(roomId, room) {
  return roomId !== TEST_ROOM_ID && room && ['streamer', 'admin'].includes(room.roomType || 'streamer')
    && /^[a-z0-9]{2,30}$/.test(String(room.streamerSoopId || '').trim().toLowerCase());
}

async function enqueueBroadcastHistoryTask(roomId, generation, dueAt, expectedRunningTaskId = '') {
  const taskId = broadcastHistoryTaskId(roomId, generation, dueAt);
  const monitorRef = broadcastHistoryMonitorRef(roomId);
  const reservation = await transactBroadcastHistoryMonitor(monitorRef, (current) => {
    if (!current || current.monitoringEnabled !== true || Number(current.monitorGeneration) !== generation) return;
    if (current.scheduledTaskId) return current;
    if (expectedRunningTaskId) {
      if (current.runningTaskId !== expectedRunningTaskId) return;
    } else if (current.runningTaskId) return;
    return { ...current, scheduledTaskId: taskId, scheduledTaskAt: dueAt, updatedAt: now() };
  });
  const state = reservation.snapshot.val();
  if (!state || state.scheduledTaskId !== taskId) return false;

  try {
    await broadcastHistoryTaskQueue().enqueue({ roomId, generation, taskId }, {
      id: taskId,
      scheduleDelaySeconds: Math.max(BROADCAST_HISTORY_TASK_START_DELAY_SECONDS, Math.ceil((dueAt - now()) / 1000)),
      dispatchDeadlineSeconds: 120,
    });
  } catch (error) {
    if (error && error.code === 'functions/task-already-exists') return true;
    await transactBroadcastHistoryMonitor(monitorRef, (current) => {
      if (!current || current.scheduledTaskId !== taskId) return;
      return { ...current, scheduledTaskId: '', scheduledTaskAt: 0, updatedAt: now() };
    });
    throw error;
  }
  return true;
}

async function ensureBroadcastHistoryMonitor(roomId) {
  const meta = (await roomRef(roomId).child('meta').get()).val();
  if (!isBroadcastHistoryRoom(roomId, meta)) return;
  const memberCount = Number(meta.memberCount) || 0;
  if (memberCount <= 0) return;

  const monitorRef = broadcastHistoryMonitorRef(roomId);
  const startedAt = now();
  const result = await transactBroadcastHistoryMonitor(monitorRef, (current) => {
    const state = {
      ...(current || { pendingVods: {}, pendingViewerAnalyses: {} }),
      pendingVods: { ...((current && current.pendingVods) || {}) },
      pendingViewerAnalyses: { ...((current && current.pendingViewerAnalyses) || {}) },
    };
    if (Number(meta.memberCount) <= 0) return;
    if (state.monitoringEnabled !== true) {
      state.monitorGeneration = (Number(state.monitorGeneration) || 0) + 1;
      state.monitoringEnabled = true;
      state.nextLiveCheckAt = startedAt;
      state.pendingVods = state.pendingVods || {};
      state.soopId = String(meta.streamerSoopId || '').trim().toLowerCase();
      state.updatedAt = startedAt;
    }
    return state;
  });
  const state = result.snapshot.val();
  if (!state || state.monitoringEnabled !== true) return;
  const generation = Number(state.monitorGeneration) || 0;
  const dueAt = Number(state.nextLiveCheckAt) || startedAt;
  await enqueueBroadcastHistoryTask(roomId, generation, dueAt);
}

async function pauseBroadcastHistoryMonitor(roomId) {
  const monitorRef = broadcastHistoryMonitorRef(roomId);
  let scheduledTaskId = '';
  const result = await transactBroadcastHistoryMonitor(monitorRef, (current) => {
    if (!current) return;
    scheduledTaskId = String(current.scheduledTaskId || '');
    if (current.monitoringEnabled === false && !scheduledTaskId && !current.runningTaskId && Number(current.nextLiveCheckAt) === 0) return current;
    return {
      ...current,
      monitoringEnabled: false,
      monitorGeneration: (Number(current.monitorGeneration) || 0) + 1,
      scheduledTaskId: '',
      scheduledTaskAt: 0,
      runningTaskId: '',
      nextLiveCheckAt: 0,
      updatedAt: now(),
    };
  });
  if (!result.committed || !scheduledTaskId) return;
  try {
    await broadcastHistoryTaskQueue().delete(scheduledTaskId);
  } catch (error) {
    // A dispatched task cannot be deleted. Its generation check makes it a no-op.
    if (!['functions/task-not-found', 'functions/task-already-exists'].includes(error && error.code)) {
      logger.warn('Could not cancel queued broadcast-history task', { roomId, taskId: scheduledTaskId, message: String(error && error.message || error).slice(0, 120) });
    }
  }
}

const messengerScheduleStreamerBroadcastHistory = onValueWritten({
  ref: '/streamerMessenger/rooms/{roomId}/meta/memberCount',
  instance: MESSENGER_DATABASE_INSTANCE,
  region: 'us-central1',
  retry: true,
}, async (event) => {
  if (await isMessengerDatabaseMigrationPaused()) throw new Error('Messenger database migration is paused.');
  const roomId = String(event.params.roomId || '');
  if (!/^[a-z0-9]{2,30}$/.test(roomId) || roomId === TEST_ROOM_ID) return;
  // Re-read the authoritative count because RTDB trigger deliveries may arrive out of order.
  const currentCount = Number((await roomRef(roomId).child('meta/memberCount').get()).val()) || 0;
  if (currentCount <= 0) {
    await pauseBroadcastHistoryMonitor(roomId);
    return;
  }
  await ensureBroadcastHistoryMonitor(roomId);
});

const messengerProcessStreamerBroadcastHistory = onTaskDispatched({
  region: 'us-central1',
  timeoutSeconds: 120,
  memory: '512MiB',
  maxInstances: 20,
  rateLimits: { maxConcurrentDispatches: BROADCAST_HISTORY_MAX_CONCURRENCY, maxDispatchesPerSecond: BROADCAST_HISTORY_MAX_CONCURRENCY },
  retryConfig: { maxAttempts: 5, minBackoffSeconds: 30, maxBackoffSeconds: 300, maxDoublings: 3 },
}, async (request) => {
  const payload = request.data || {};
  const roomId = String(payload.roomId || '');
  const generation = Number(payload.generation);
  const taskId = String(payload.taskId || '');
  if (!/^[a-z0-9]{2,30}$/.test(roomId) || roomId === TEST_ROOM_ID || !Number.isInteger(generation) || !/^bh-[a-f0-9]{48}$/.test(taskId)) {
    logger.warn('Invalid broadcast-history task payload');
    return;
  }

  const monitorRef = broadcastHistoryMonitorRef(roomId);
  const monitorBeforeClaim = (await monitorRef.get()).val();
  let claimDecision = '';
  const claim = await transactBroadcastHistoryMonitor(monitorRef, (current) => {
    if (!current) {
      claimDecision = 'missing-monitor';
      return;
    }
    if (current.monitoringEnabled !== true) {
      claimDecision = 'monitor-disabled';
      return;
    }
    if (Number(current.monitorGeneration) !== generation) {
      claimDecision = 'generation-mismatch';
      return;
    }
    if (current.scheduledTaskId === taskId) {
      claimDecision = 'claimed-scheduled-task';
      const startedAt = now();
      return { ...current, scheduledTaskId: '', scheduledTaskAt: 0, runningTaskId: taskId, runningStartedAt: startedAt, lastTaskStartedAt: startedAt, updatedAt: startedAt };
    }
    // Cloud Tasks may redeliver a task after a transient failure.
    if (current.runningTaskId === taskId) {
      claimDecision = 'redelivered-running-task';
      return current;
    }
    claimDecision = 'task-id-mismatch';
  }, monitorBeforeClaim);
  let stateAtClaim = claim.snapshot.val();
  if (!stateAtClaim || stateAtClaim.runningTaskId !== taskId || Number(stateAtClaim.monitorGeneration) !== generation) {
    logger.warn('Skipped stale broadcast-history task', {
      roomId,
      taskGeneration: generation,
      hasMonitor: !!monitorBeforeClaim,
      monitoringEnabled: monitorBeforeClaim && monitorBeforeClaim.monitoringEnabled === true,
      storedGeneration: monitorBeforeClaim && Number(monitorBeforeClaim.monitorGeneration),
      generationMatches: !!monitorBeforeClaim && Number(monitorBeforeClaim.monitorGeneration) === generation,
      scheduledTaskMatches: !!monitorBeforeClaim && monitorBeforeClaim.scheduledTaskId === taskId,
      runningTaskMatches: !!monitorBeforeClaim && monitorBeforeClaim.runningTaskId === taskId,
      claimCommitted: claim.committed,
      claimDecision,
      claimedScheduledTaskMatches: !!stateAtClaim && stateAtClaim.scheduledTaskId === taskId,
      claimedRunningTaskMatches: !!stateAtClaim && stateAtClaim.runningTaskId === taskId,
      claimedGeneration: stateAtClaim && Number(stateAtClaim.monitorGeneration),
    });
    return;
  }

  const [metaSnapshot, roomSnapshot] = await Promise.all([
    roomRef(roomId).child('meta').get(),
    db().ref(`${ROOT}/publicRooms/${roomId}`).get(),
  ]);
  const meta = metaSnapshot.val();
  const projectedRoom = roomSnapshot.val();
  const room = { ...(projectedRoom || {}), ...(meta || {}) };
  if (!isBroadcastHistoryRoom(roomId, room)) {
    await pauseBroadcastHistoryMonitor(roomId);
    return;
  }
  const memberCount = await getBroadcastHistoryMemberCount(roomId, projectedRoom);
  if (memberCount <= 0) {
    await pauseBroadcastHistoryMonitor(roomId);
    return;
  }

  const checkedAt = now();
  const soopId = String(room.streamerSoopId || '').trim().toLowerCase();
  stateAtClaim = {
    ...stateAtClaim,
    pendingVods: { ...(stateAtClaim.pendingVods || {}) },
    pendingViewerAnalyses: { ...(stateAtClaim.pendingViewerAnalyses || {}) },
    soopId,
  };
  const updates = {};
  const liveCheckDue = !Number(stateAtClaim.nextLiveCheckAt) || Number(stateAtClaim.nextLiveCheckAt) <= checkedAt;
  if (liveCheckDue) {
    try {
      const status = await fetchSoopStationStatus(soopId);
      if (status.isLive) {
        if (stateAtClaim.activeBroadcastId && stateAtClaim.activeBroadcastId !== status.broadcastId) {
          await endTrackedBroadcast(roomId, stateAtClaim, checkedAt, updates);
        }
        if (!stateAtClaim.activeBroadcastId) await startTrackedBroadcast(roomId, room, soopId, status, stateAtClaim, checkedAt, updates);
        stateAtClaim.nextLiveCheckAt = checkedAt + BROADCAST_HISTORY_LIVE_POLL_MS;
      } else {
        if (stateAtClaim.activeBroadcastId) await endTrackedBroadcast(roomId, stateAtClaim, checkedAt, updates);
        stateAtClaim.nextLiveCheckAt = checkedAt + BROADCAST_HISTORY_IDLE_POLL_MS;
      }
      stateAtClaim.lastSuccessfulCheckAt = checkedAt;
      stateAtClaim.lastErrorAt = 0;
    } catch (error) {
      stateAtClaim.nextLiveCheckAt = checkedAt + BROADCAST_HISTORY_ERROR_POLL_MS;
      stateAtClaim.lastErrorAt = checkedAt;
      logger.warn('SOOP broadcaster status sync failed', { roomId, soopId, message: String(error && error.message || error).slice(0, 120) });
    }
  }

  const dueVod = Object.values(stateAtClaim.pendingVods)
    .filter((pending) => pending && Number(pending.nextLookupAt) <= checkedAt)
    .sort((a, b) => Number(a.nextLookupAt) - Number(b.nextLookupAt))[0];
  if (dueVod) await updatePendingBroadcastVod(roomId, dueVod, stateAtClaim, updates, checkedAt);
  const dueViewerAnalysis = Object.values(stateAtClaim.pendingViewerAnalyses)
    .filter((pending) => pending && Number(pending.nextCheckAt) <= checkedAt)
    .sort((a, b) => Number(a.nextCheckAt) - Number(b.nextCheckAt))[0];
  if (dueViewerAnalysis) {
    await processPendingBroadcastViewerAnalysis(roomId, dueViewerAnalysis, stateAtClaim, updates, checkedAt);
  }
  for (const [broadcastId, pending] of Object.entries(stateAtClaim.pendingVods)) {
    if (!pending || checkedAt - Number(pending.endedAt || 0) > 48 * 60 * 60 * 1000) delete stateAtClaim.pendingVods[broadcastId];
  }
  for (const [broadcastId, pending] of Object.entries(stateAtClaim.pendingViewerAnalyses)) {
    if (!pending) {
      delete stateAtClaim.pendingViewerAnalyses[broadcastId];
      continue;
    }
    if (checkedAt - Number(pending.createdAt || 0) <= 48 * 60 * 60 * 1000) continue;
    const messagePath = broadcastHistoryMessagePath(roomId, pending.messageId);
    const messageSnapshot = await db().ref(messagePath).get();
    const message = updates[messagePath] || messageSnapshot.val();
    if (message && message.viewerAnalysis && message.viewerAnalysis.status === 'pending') {
      addBroadcastHistoryMessageUpdates(updates, roomId, {
        ...message,
        viewerAnalysis: { status: 'unavailable', checkedAt },
        updatedAt: checkedAt,
      });
    }
    delete stateAtClaim.pendingViewerAnalyses[broadcastId];
  }
  stateAtClaim.updatedAt = checkedAt;

  // Do not publish a result if the last participant left while an external request was in flight.
  const latestMemberCount = await getBroadcastHistoryMemberCount(roomId, (await db().ref(`${ROOT}/publicRooms/${roomId}`).get()).val());
  const latestMonitor = (await monitorRef.get()).val();
  if (latestMemberCount <= 0) {
    await pauseBroadcastHistoryMonitor(roomId);
    return;
  }
  if (!latestMonitor || latestMonitor.monitoringEnabled !== true || Number(latestMonitor.monitorGeneration) !== generation || latestMonitor.runningTaskId !== taskId) return;

  if (Object.keys(updates).length) await db().ref().update(updates);
  const stateSave = await transactBroadcastHistoryMonitor(monitorRef, (current) => {
    if (!current || current.monitoringEnabled !== true || Number(current.monitorGeneration) !== generation || current.runningTaskId !== taskId) return;
    return {
      ...stateAtClaim,
      monitoringEnabled: true,
      monitorGeneration: generation,
      scheduledTaskId: current.scheduledTaskId || '',
      scheduledTaskAt: Number(current.scheduledTaskAt) || 0,
      runningTaskId: taskId,
      runningStartedAt: Number(current.runningStartedAt) || checkedAt,
    };
  }, latestMonitor);
  const savedState = stateSave.snapshot.val();
  if (!stateSave.committed || !savedState || savedState.runningTaskId !== taskId || Number(savedState.monitorGeneration) !== generation) return;

  const dueTimes = [
    Number(savedState.nextLiveCheckAt),
    ...Object.values(savedState.pendingVods || {}).map((pending) => Number(pending && pending.nextLookupAt)),
    ...Object.values(savedState.pendingViewerAnalyses || {}).map((pending) => Number(pending && pending.nextCheckAt)),
  ]
    .filter((value) => value > 0);
  const nextDueAt = dueTimes.length ? Math.min(...dueTimes) : checkedAt + BROADCAST_HISTORY_IDLE_POLL_MS;
  await enqueueBroadcastHistoryTask(roomId, generation, nextDueAt, taskId);
  await transactBroadcastHistoryMonitor(monitorRef, (current) => {
    if (!current || current.monitorGeneration !== generation || current.runningTaskId !== taskId) return;
    return { ...current, runningTaskId: '', runningStartedAt: 0, updatedAt: now() };
  });
});

const messengerGetStreamerLiveStatus = onCall({ maxInstances: 10 }, async (request) => {
  const data = request.data || {};
  const roomId = String(data.roomId || '');
  const principal = await requireRoomPrincipal(request, roomId);
  const { meta } = await requireRoomMember(principal, roomId);
  const soopId = String(meta.streamerSoopId || '').trim().toLowerCase();
  if (!/^[a-z0-9]{2,30}$/.test(soopId)) throw new HttpsError('failed-precondition', '이 채팅방의 SOOP 아이디를 확인할 수 없습니다.');

  const cached = soopLiveStatusCache.get(soopId);
  if (cached && cached.expiresAt > now()) return cached.value;

  let status;
  try {
    status = await fetchSoopStationStatus(soopId);
  } catch (error) {
    logger.warn('SOOP live status request failed', { roomId, soopId, message: String(error && error.message || error).slice(0, 120) });
    throw new HttpsError('unavailable', 'SOOP 방송 상태를 확인하지 못했습니다. 방송국 후원 링크를 열어 주세요.');
  }
  const checkedAt = now();
  const value = { ...status, checkedAt };

  soopLiveStatusCache.set(soopId, { value, expiresAt: checkedAt + SOOP_LIVE_STATUS_CACHE_TTL });
  if (soopLiveStatusCache.size > 100) {
    for (const [key, entry] of soopLiveStatusCache) if (entry.expiresAt <= checkedAt) soopLiveStatusCache.delete(key);
    if (soopLiveStatusCache.size > 100) soopLiveStatusCache.delete(soopLiveStatusCache.keys().next().value);
  }
  return value;
});

const messengerSearchStreamerClips = onCall({ maxInstances: 10 }, async (request) => {
  const data = request.data || {};
  const roomId = String(data.roomId || '');
  const principal = await requireRoomPrincipal(request, roomId);
  const { meta } = await requireRoomMember(principal, roomId);
  const soopId = String(meta.streamerSoopId || '').trim().toLowerCase();
  if (!/^[a-z0-9]{2,30}$/.test(soopId)) throw new HttpsError('failed-precondition', '이 채팅방의 클립을 찾을 수 없습니다.');

  const query = safeText(data.query == null ? '' : String(data.query), 80);
  const page = Number(data.page || 1);
  if (!Number.isInteger(page) || page < 1 || page > 1000) throw new HttpsError('invalid-argument', '클립 페이지가 올바르지 않습니다.');
  const cacheKey = `${soopId}\n${query}\n${page}`;
  const cached = soopClipSearchCache.get(cacheKey);
  if (cached && cached.expiresAt > now()) return cached.value;

  const endpoint = new URL(`https://chapi.sooplive.com/api/${encodeURIComponent(soopId)}/vods/clip/all`);
  endpoint.searchParams.set('orderby', 'reg_date');
  endpoint.searchParams.set('page', String(page));
  endpoint.searchParams.set('field', 'title,contents,user_nick,user_id');
  endpoint.searchParams.set('per_page', '20');
  if (query) endpoint.searchParams.set('keyword', query);

  let payload;
  try {
    const response = await fetch(endpoint, {
      headers: { Accept: 'application/json', 'User-Agent': 'StreamerMessenger/1.0' },
      signal: AbortSignal.timeout(9000),
    });
    if (!response.ok) throw new Error(`SOOP responded ${response.status}`);
    payload = await response.json();
  } catch (error) {
    logger.warn('SOOP clip search failed', { roomId, soopId, message: String(error && error.message || error).slice(0, 120) });
    throw new HttpsError('unavailable', 'SOOP 클립을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
  }

  const records = Array.isArray(payload && payload.data) ? payload.data : [];
  const clips = records.map((record) => {
    const clipId = String(record && record.title_no || '');
    if (!/^\d{1,20}$/.test(clipId)) return null;
    const thumbnailValue = String(record && record.ucc && record.ucc.thumb || '');
    let thumbnailUrl = '';
    try {
      const parsed = new URL(thumbnailValue.startsWith('//') ? `https:${thumbnailValue}` : thumbnailValue);
      if (parsed.protocol === 'https:' && (parsed.hostname === 'sooplive.com' || parsed.hostname.endsWith('.sooplive.com'))) thumbnailUrl = parsed.href;
    } catch (_) { /* 잘못된 썸네일은 생략 */ }
    return {
      id: clipId,
      title: String(record.title_name || '제목 없는 클립').replace(/\s+/g, ' ').trim().slice(0, 180),
      uploader: String(record.user_nick || '').replace(/\s+/g, ' ').trim().slice(0, 80),
      createdAt: String(record.reg_date || '').slice(0, 32),
      durationMs: Math.max(0, Number(record.ucc && record.ucc.total_file_duration) || 0),
      thumbnailUrl,
      url: `https://vod.sooplive.com/player/${clipId}`,
    };
  }).filter(Boolean);
  const metaData = payload && payload.meta || {};
  const result = {
    clips,
    page: Number(metaData.current_page) || page,
    total: Math.max(0, Number(metaData.total) || 0),
    hasMore: Number(metaData.current_page || page) < Number(metaData.last_page || page),
  };
  soopClipSearchCache.set(cacheKey, { expiresAt: now() + SOOP_CLIP_CACHE_TTL, value: result });
  for (const [key, entry] of soopClipSearchCache) if (entry.expiresAt <= now()) soopClipSearchCache.delete(key);
  while (soopClipSearchCache.size > SOOP_CLIP_CACHE_LIMIT) soopClipSearchCache.delete(soopClipSearchCache.keys().next().value);
  return result;
});

const messengerSendMessage = onCall({ maxInstances: 30 }, async (request) => {
  const data = request.data || {};
  const roomId = String(data.roomId || '');
  const access = await requireRoomSendAccess(request, roomId);
  const p = access.principal;
  const result = access.roomAccess;
  if (!result.isOwner && result.meta.locked) throw new HttpsError('failed-precondition', '채팅방이 잠겨 있어 스트리머만 메시지를 보낼 수 있습니다.');
  const member = result.member || {};
  const isOwner = result.isOwner;
  const kind = String(data.kind || 'text');
  if (!['text', 'image', 'roomself', 'emote'].includes(kind)) throw new HttpsError('invalid-argument', '메시지 유형이 올바르지 않습니다.');
  let emoteSticker = null;
  if (kind === 'emote') {
    emoteSticker = messengerStickerIndex.get(String(data.stickerId || '')) || null;
    if (!emoteSticker) throw new HttpsError('invalid-argument', '알 수 없는 스티커입니다.');
  }
  const recipientUid = isOwner && data.recipientUid ? String(data.recipientUid) : '';
  const requestedMessageId = String(data.clientMessageId || '');
  if (requestedMessageId && !/^[A-Za-z0-9_-]{20}$/.test(requestedMessageId)) throw new HttpsError('invalid-argument', '메시지 식별자가 올바르지 않습니다.');
  const messagePath = `${ROOT}/chat/${roomId}/streamerTimeline`;
  const [, recipient] = await Promise.all([
    emoteSticker ? assertEmoteAvailable(request, p.uid, emoteSticker) : Promise.resolve(),
    isOwner && recipientUid ? roomRef(roomId).child(`members/${recipientUid}`).get() : Promise.resolve(null),
  ]);
  if (isOwner && recipientUid && (!recipient || !recipient.exists() || recipient.val().status !== 'active')) {
    throw new HttpsError('failed-precondition', '참여 중인 팬에게만 다이렉트 메시지를 보낼 수 있습니다.');
  }
  const recipientName = recipient && recipient.val() && recipient.val().profile
    ? String(recipient.val().profile.nickname || '팬').slice(0, 30)
    : (recipientUid ? '팬' : '');
  const text = ['image', 'roomself', 'emote'].includes(kind) ? '' : safeText(data.text, MESSAGE_MAX, true);
  if (kind === 'roomself' && (!isOwner || !recipientUid)) throw new HttpsError('permission-denied', '스트리머가 지정한 팬에게만 방셀을 보낼 수 있습니다.');
  const { staleRateBucketCleanup } = await applyMessageRate(p.uid, roomId, emoteSticker ? `[스티커:${emoteSticker.id}]` : text, result.meta, isOwner);
  if (requestedMessageId && (await db().ref(`${messagePath}/${requestedMessageId}`).get()).exists()) {
    throw new HttpsError('already-exists', '메시지가 이미 전송되었습니다. 대화 내용을 새로고침해 주세요.');
  }
  const createdAt = now();
  const messageId = requestedMessageId || db().ref(messagePath).push().key;
  const common = { id: messageId, roomId, senderUid: p.uid, senderRole: isOwner ? 'streamer' : 'fan', createdAt, recipientUid: recipientUid || null, ...(recipientUid ? { recipientName } : {}) };
  let message;
  if (kind === 'image') {
    const image = await galleryImageForChat(roomId, String(data.galleryImageId || ''));
    message = { ...common, kind: 'image', galleryImageId: image.imageId };
  } else if (kind === 'roomself') {
    const id = String(data.roomselfImageId || '');
    if (!/^[a-f0-9]{32}$/.test(id)) throw new HttpsError('invalid-argument', '방셀 이미지가 선택되지 않았습니다.');
    const imageRef = db().ref(`${ROOT}/privateImages/${id}`); const imageSnap = await imageRef.get(); const image = imageSnap.val() || {};
    if (!imageSnap.exists() || image.roomId !== roomId || image.ownerUid !== p.uid || image.recipientUid !== recipientUid || image.status !== 'uploaded' || now() > Number(image.expiresAt)) throw new HttpsError('failed-precondition', '방셀 업로드가 만료되었거나 올바르지 않습니다. 다시 선택해 주세요.');
    message = { ...common, kind: 'roomself', roomselfImageId: id };
    message._roomselfImageRef = id;
  } else if (kind === 'emote') {
    message = { ...common, kind: 'emote', stickerId: emoteSticker.id };
  } else {
    message = { ...common, kind: 'text', text };
  }
  if (data.replyToId) message.replyToId = safeText(String(data.replyToId), 100, true);
  if (data.replyToUid) message.replyToUid = safeText(String(data.replyToUid), 128, true);
  if (isOwner && message.replyToId) {
    if (!recipientUid || message.replyToUid !== recipientUid) throw new HttpsError('invalid-argument', '답변 대상이 올바르지 않습니다.');
    const replied = await db().ref(`${ROOT}/chat/${roomId}/streamerTimeline/${message.replyToId}`).get();
    const target = replied.val() || {};
    if (!replied.exists() || target.senderUid !== recipientUid && target.recipientUid !== recipientUid) throw new HttpsError('permission-denied', '해당 팬의 메시지에만 답변할 수 있습니다.');
  }
  const profile = isOwner
    ? { nickname: result.meta.streamerNickname || '스트리머', avatarUrl: result.meta.streamerAvatarUrl || '' }
    : (member.profile || await profileFor(p.uid));
  message.senderName = profile.nickname || (isOwner ? '스트리머' : '팬');
  message.senderAvatarUrl = profile.avatarUrl || '';
  message.scope = isOwner ? (recipientUid ? (message.replyToId ? 'reply' : 'direct') : 'broadcast') : 'fan';
  const updates = {};
  if (message._roomselfImageRef) {
    const id = message._roomselfImageRef;
    delete message._roomselfImageRef;
    message.roomselfImageId = id;
    updates[`${ROOT}/privateImages/${id}/status`] = 'sent';
    updates[`${ROOT}/privateImages/${id}/messageId`] = messageId;
    updates[`${ROOT}/privateImages/${id}/sentAt`] = createdAt;
    updates[`${ROOT}/privateImages/${id}/expiresAt`] = createdAt + CHAT_RETENTION;
  }
  updates[`${ROOT}/chat/${roomId}/streamerTimeline/${messageId}`] = message;
  if (isOwner && !recipientUid) updates[`${ROOT}/chat/${roomId}/broadcast/${messageId}`] = message;
  else {
    const fanUid = isOwner ? recipientUid : p.uid;
    updates[`${ROOT}/chat/${roomId}/private/${fanUid}/${messageId}`] = message;
  }
  await Promise.all([db().ref().update(updates), staleRateBucketCleanup]);
  return { message };
});

const messengerSubmitReport = onCall(async (request) => {
  const p = await getPrincipal(request, { requireTrusted: true });
  if (p.testAccount) throw new HttpsError('permission-denied', '테스트 계정에서는 대화 신고를 접수할 수 없습니다.');
  const { roomId, startAt, endAt, reasonCategory, reason } = request.data || {};
  const reasonCategories = new Set(['harassment', 'spam', 'privacy', 'sexual', 'impersonation', 'other']);
  if (!reasonCategories.has(reasonCategory)) throw new HttpsError('invalid-argument', '신고 사유를 선택해 주세요.');
  const { meta, isOwner } = await requireRoomMember(p, String(roomId || ''));
  const start = Number(startAt); const end = Number(endAt); const at = now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end - start > 24 * 60 * 60 * 1000 || start < at - CHAT_RETENTION || end > at) {
    throw new HttpsError('invalid-argument', '신고할 대화 범위는 최근 7일 안에서 최대 1일로 선택해 주세요.');
  }
  let targetUid = meta.ownerUid;
  if (isOwner) {
    targetUid = String((request.data || {}).targetUid || '');
    const targetMember = await roomRef(roomId).child(`members/${targetUid}`).get();
    if (!targetMember.exists() || targetMember.val().status !== 'active') throw new HttpsError('invalid-argument', '신고할 팬을 선택해 주세요.');
  }
  const visible = [];
  const timelineRef = db().ref(`${ROOT}/chat/${roomId}/streamerTimeline`);
  let query = timelineRef.orderByChild('createdAt').startAt(start).endAt(end).limitToFirst(100);
  while (query) {
    const page = await query.get();
    let lastKey = '';
    let lastCreatedAt = 0;
    page.forEach((child) => {
      lastKey = child.key;
      const m = child.val() || {};
      lastCreatedAt = Number(m.createdAt) || lastCreatedAt;
      const allowed = isOwner
        ? (m.senderUid === targetUid || m.recipientUid === targetUid || m.senderRole === 'streamer' && (!m.recipientUid || m.recipientUid === targetUid))
        : (m.senderUid === p.uid || m.senderRole === 'streamer' && (!m.recipientUid || m.recipientUid === p.uid));
      if (allowed) visible.push(m);
    });
    if (visible.length > 500) throw new HttpsError('resource-exhausted', '선택한 범위에 신고 증거가 500개를 넘습니다. 시간 범위를 좁혀 접수해 주세요.');
    if (page.numChildren() < 100 || !lastKey) break;
    query = timelineRef.orderByChild('createdAt').startAfter(lastCreatedAt, lastKey).endAt(end).limitToFirst(100);
  }
  if (!visible.length) throw new HttpsError('failed-precondition', '선택 범위에서 신고할 대화를 찾을 수 없습니다.');
  const reportRef = db().ref(`${ROOT}/reports`).push();
  const reportId = reportRef.key;
  const reasonDetail = safeText(typeof reason === 'string' ? reason : '', 300);
  const item = { id: reportId, roomId, reporterUid: p.uid, targetUid, streamerId: meta.streamerId, reason: reasonCategory, reasonCategory, reasonDetail, status: 'pending', createdAt: at, retainUntil: at + REPORT_RETENTION, rangeStart: start, rangeEnd: end };
  const evidence = {};
  const updates = { [`${ROOT}/reports/${reportId}`]: item };
  visible.forEach((m) => {
    evidence[m.id] = m;
    if (m.kind === 'image' && m.galleryImageId) updates[`${ROOT}/reportImageRefs/${m.galleryImageId}/${reportId}/${m.id}`] = item.retainUntil;
    if (m.kind === 'roomself' && m.roomselfImageId) updates[`${ROOT}/privateImageRefs/${m.roomselfImageId}/${reportId}`] = item.retainUntil;
  });
  const imageMessages = visible.filter((m) => m.kind === 'image' && m.galleryImageId);
  for (let offset = 0; offset < imageMessages.length; offset += 25) {
    await Promise.all(imageMessages.slice(offset, offset + 25).map(async (message) => {
      const imageSnap = await sharedDb().ref(`gallery/imagesPublic/${message.galleryImageId}`).get();
      const image = imageSnap.val() || {};
      if (image.imageUrl) evidence[message.id] = { ...message, reportImageUrl: image.imageUrl, reportThumbUrl: image.thumbUrl || '' };
    }));
  }
  updates[`${ROOT}/reportEvidence/${reportId}`] = evidence;
  await db().ref().update(updates);
  await writeAudit(p.uid, 'report.submit', reportId);
  return { reportId };
});

const messengerAdminGetDashboard = onCall(async (request) => {
  const p = await requireAdmin(request);
  const data = request.data || {};
  await ensureMessengerBanIndex();
  const requestedStatus = String(data.reportStatus || 'pending');
  if (!['pending', 'reviewed', 'dismissed', 'all'].includes(requestedStatus)) throw new HttpsError('invalid-argument', '신고 상태 필터가 올바르지 않습니다.');
  const reportCursor = data.reportCursor && typeof data.reportCursor === 'object' ? data.reportCursor : null;
  const banCursor = typeof data.banCursor === 'string' ? data.banCursor : null;
  if (reportCursor && (!/^[A-Za-z0-9_-]{8,100}$/.test(String(reportCursor.id || '')) || (requestedStatus === 'all' && !Number.isFinite(Number(reportCursor.createdAt))))) {
    throw new HttpsError('invalid-argument', '신고 페이지 위치가 올바르지 않습니다.');
  }
  if (banCursor && !/^[A-Za-z0-9:_-]{1,128}$/.test(banCursor)) throw new HttpsError('invalid-argument', '정지 계정 페이지 위치가 올바르지 않습니다.');
  const includeBans = data.includeBans === true;
  const includeReports = data.includeReports !== false;
  if (includeReports) await ensureReportStatuses();
  const [reportPage, pendingSnap, auditSnap, banCountSnap, banPage] = await Promise.all([
    includeReports ? getAdminReportPage(requestedStatus, reportCursor) : Promise.resolve({ reports: [], hasMore: false, nextCursor: null }),
    includeReports ? db().ref(`${ROOT}/reports`).orderByChild('status').equalTo('pending').get() : Promise.resolve(null),
    includeReports ? db().ref(`${ROOT}/auditLog`).limitToLast(100).get() : Promise.resolve(null),
    db().ref(`${ROOT}/admin/activeBanCount`).get(),
    includeBans ? getAdminBanPage(banCursor) : Promise.resolve({ bans: [], hasMore: false, nextCursor: null }),
  ]);
  const auditLog = [];
  if (auditSnap) auditSnap.forEach((child) => auditLog.push({ ...(child.val() || {}), id: child.key }));
  auditLog.sort((a, b) => b.at - a.at);
  return {
    reports: reportPage.reports,
    reportPage: { hasMore: reportPage.hasMore, nextCursor: reportPage.nextCursor, status: requestedStatus },
    bans: banPage.bans,
    banPage: { hasMore: banPage.hasMore, nextCursor: banPage.nextCursor },
    auditLog,
    summary: {
      pendingReports: pendingSnap ? pendingSnap.numChildren() : null,
      activeBans: Number(banCountSnap.val()) || 0,
    },
  };
});

const messengerAdminGetVisitorAnalytics = onCall(async (request) => {
  await requireAdmin(request);
  const database = db();
  const at = now();
  const windowMs = 60 * 60 * 1000;
  const dayMs = 24 * windowMs;
  const timezoneOffsetMs = 9 * windowMs;
  const requestedDays = Number((request.data || {}).days ?? 7);
  if (!Number.isInteger(requestedDays) || requestedDays < 1 || requestedDays > 30) {
    throw new HttpsError('invalid-argument', '조회 기간은 1일부터 30일까지 선택해 주세요.');
  }
  const hourKeys = Array.from({ length: 24 }, (_, index) => new Date(at - (23 - index) * windowMs).toISOString().slice(0, 13));
  const kstNow = new Date(at + timezoneOffsetMs);
  const currentKstMidnight = Date.UTC(kstNow.getUTCFullYear(), kstNow.getUTCMonth(), kstNow.getUTCDate()) - timezoneOffsetMs;
  const firstKstMidnight = currentKstMidnight - (requestedDays - 1) * dayMs;
  const firstHourKey = new Date(firstKstMidnight).toISOString().slice(0, 13);
  const dailyKeys = Array.from({ length: requestedDays }, (_, index) => new Date(firstKstMidnight + index * dayMs + timezoneOffsetMs).toISOString().slice(0, 10));
  const [presenceSnap, hourlySnap] = await Promise.all([
    database.ref('presence/streamerMessenger').get(),
    database.ref('analytics/presenceHourly/streamerMessenger').orderByKey().startAt(firstHourKey).endAt(hourKeys[hourKeys.length - 1]).get(),
  ]);
  const presence = presenceSnap.val() || {};
  const recentCount = Object.values(presence).filter((entry) => entry && typeof entry.lastSeen === 'number' && at - entry.lastSeen <= windowMs).length;
  const hourlyData = hourlySnap.val() || {};
  const hourly = hourKeys.map((hour) => ({
    hour,
    peak: Math.max(0, Number(hourlyData[hour] && hourlyData[hour].peak) || 0),
    sampledAt: Number(hourlyData[hour] && hourlyData[hour].sampledAt) || null,
  }));
  const peakHour = hourly.reduce((best, item) => item.peak > (best ? best.peak : 0) ? item : best, null);
  const dailyPeaks = Object.fromEntries(dailyKeys.map((day) => [day, 0]));
  Object.entries(hourlyData).forEach(([hour, entry]) => {
    const timestamp = Date.parse(`${hour}:00:00Z`);
    if (!Number.isFinite(timestamp)) return;
    const kstDay = new Date(timestamp + timezoneOffsetMs).toISOString().slice(0, 10);
    if (Object.hasOwn(dailyPeaks, kstDay)) dailyPeaks[kstDay] = Math.max(dailyPeaks[kstDay], Number(entry && entry.peak) || 0);
  });
  const daily = dailyKeys.map((day) => ({ day, peak: dailyPeaks[day] }));
  return { recentCount, sampledAt: at, recentWindowMs: windowMs, hourly, peakHour, days: requestedDays, daily };
});

async function withUsageSnapshotLock(operation) {
  const lockRef = db().ref(USAGE_SNAPSHOT_LOCK_PATH);
  const token = crypto.randomBytes(16).toString('hex');
  const lockResult = await lockRef.transaction((current) => {
    if (current && Number(current.expiresAt) > now()) return;
    return { token, expiresAt: now() + 15 * 60 * 1000 };
  });
  if (!lockResult.committed) return { acquired: false, value: null };
  try {
    return { acquired: true, value: await operation() };
  } finally {
    await lockRef.transaction((current) => current && current.token === token ? null : undefined).catch((error) => {
      logger.warn('메신저 사용량 집계 잠금을 해제하지 못했습니다.', { code: error && error.code });
    });
  }
}

async function readUsageSnapshot(s3) {
  try {
    return await usageAnalytics.readSnapshot(s3, roomselfSecretAccessKey.value());
  } catch (error) {
    logger.warn('메신저 사용량 정적 집계를 읽지 못했습니다.', { code: error && (error.code || error.name) });
    return null;
  }
}

const messengerAdminGetUsageAnalytics = onCall({
  region: 'us-central1',
  secrets: [roomselfAccessKeyId, roomselfSecretAccessKey],
  timeoutSeconds: 540,
  memory: '1GiB',
}, async (request) => {
  await requireAdmin(request);
  const s3 = roomselfS3();
  let report = await readUsageSnapshot(s3);
  if (!report || Number(report.schemaVersion) < 2) {
    const result = await withUsageSnapshotLock(async () => {
      const current = await readUsageSnapshot(s3);
      if (current && Number(current.schemaVersion) >= 2) return current;
      const generated = await usageAnalytics.collectUsageSnapshot(s3, roomselfSecretAccessKey.value(), {
        logError: (metric, code, message) => logger.warn('Cloud Monitoring 사용량을 읽지 못했습니다.', { metric, code, message: String(message || '').slice(0, 160) }),
      });
      await usageAnalytics.writeSnapshot(s3, generated, roomselfSecretAccessKey.value());
      return generated;
    });
    report = result.value;
    if (!result.acquired && !report) {
      for (let attempt = 0; attempt < 20 && !report; attempt += 1) {
        await sleep(1000);
        report = await readUsageSnapshot(s3);
      }
    }
    if (!report) throw new HttpsError('unavailable', '사용량 집계 파일을 준비 중입니다. 잠시 후 다시 열어 주세요.');
  }
  return report;
});

const messengerAdminGetBanStatus = onCall(async (request) => {
  const p = await requireAdmin(request);
  const uid = String((request.data || {}).uid || '').trim();
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(uid)) throw new HttpsError('invalid-argument', '계정 UID를 확인해 주세요.');
  const [snap, accountSnap] = await Promise.all([
    sharedDb().ref(`bannedAccounts/${uid}/games/${SERVICE_ID}`).get(),
    sharedDb().ref(`bannedAccounts/${uid}`).get(),
  ]);
  const adminSnap = await sharedDb().ref(`adminCenter/adminUids/${uid}`).get();
  const account = accountSnap.val() || {};
  const globalBan = account.all === true ? {
    reason: String(account.allReason || ''),
    at: Number(account.allBannedAt) || 0,
    by: String(account.allBannedBy || ''),
    byName: String(account.allBannedByName || ''),
  } : null;
  await writeAudit(p.uid, 'account.status.view', uid);
  return { uid, ban: snap.val() || null, globalBan, isAdmin: adminSnap.val() === true };
});

const messengerAdminGetReportDetail = onCall(async (request) => {
  const p = await requireAdmin(request);
  const reportId = String((request.data || {}).reportId || '');
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(reportId)) throw new HttpsError('invalid-argument', '신고 번호가 올바르지 않습니다.');
  const [reportSnap, evidenceSnap] = await Promise.all([
    db().ref(`${ROOT}/reports/${reportId}`).get(), db().ref(`${ROOT}/reportEvidence/${reportId}`).get(),
  ]);
  if (!reportSnap.exists()) throw new HttpsError('not-found', '신고를 찾을 수 없습니다.');
  const report = reportSnap.val() || {};
  const retainUntil = Number(report.retainUntil);
  if (!report.id || !Number.isFinite(retainUntil) || retainUntil <= now()) throw new HttpsError('not-found', '신고 증거 보관 기간이 끝났습니다.');
  const evidence = Object.values(evidenceSnap.val() || {}).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  await writeAudit(p.uid, 'report.view', reportId);
  return { report, evidence };
});

const messengerAdminGetReportRoomselfImage = onCall({ secrets: [roomselfAccessKeyId, roomselfSecretAccessKey] }, async (request) => {
  const p = await requireAdmin(request);
  const { reportId, imageId } = request.data || {};
  if (typeof reportId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(reportId) || typeof imageId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(imageId)) throw new HttpsError('invalid-argument', '신고 이미지 정보가 올바르지 않습니다.');
  const report = (await db().ref(`${ROOT}/reports/${reportId}`).get()).val() || {};
  const retainUntil = Number(report.retainUntil);
  if (!report.id || !Number.isFinite(retainUntil) || retainUntil <= now()) throw new HttpsError('not-found', '신고 증거 보관 기간이 끝났습니다.');
  if (!await db().ref(`${ROOT}/privateImageRefs/${imageId}/${reportId}`).get().then((s) => s.exists())) throw new HttpsError('permission-denied', '이 신고에 포함된 이미지가 아닙니다.');
  const record = (await db().ref(`${ROOT}/privateImages/${imageId}`).get()).val() || {};
  if (record.status !== 'sent' || record.roomId !== report.roomId) throw new HttpsError('not-found', '신고 이미지를 찾을 수 없습니다.');
  const object = await roomselfS3().send(new GetObjectCommand({ Bucket: ROOMSELF_BUCKET, Key: record.key }));
  const bytes = await object.Body.transformToByteArray();
  await writeAudit(p.uid, 'report.private-image.view', `${reportId} · ${imageId}`);
  return { contentType: record.contentType, data: Buffer.from(bytes).toString('base64') };
});

const messengerAdminUpdateReport = onCall(async (request) => {
  const p = await requireAdmin(request);
  const { reportId, status, reviewNote } = request.data || {};
  if (typeof reportId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(reportId) || !['pending', 'reviewed', 'dismissed'].includes(status)) throw new HttpsError('invalid-argument', '신고 처리 정보가 올바르지 않습니다.');
  const cleanNote = safeText(reviewNote || '', 500, true);
  const ref = db().ref(`${ROOT}/reports/${reportId}`);
  let previousStatus = 'pending';
  const result = await ref.transaction((current) => {
    if (!current) return;
    previousStatus = current.status || 'pending';
    return { ...current, status, reviewedAt: now(), reviewedBy: p.uid, reviewNote: cleanNote };
  });
  if (!result.committed) throw new HttpsError('not-found', '신고를 찾을 수 없습니다.');
  const action = status === 'pending' ? 'report.reopened' : `report.${status}`;
  await writeAudit(p.uid, action, `${reportId} · ${previousStatus} → ${status} · ${cleanNote}`);
  return { status };
});

const messengerAdminSetBan = onCall(async (request) => {
  const p = await requireAdmin(request);
  const { uid, banned, reason } = request.data || {};
  if (typeof uid !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(uid) || typeof banned !== 'boolean') throw new HttpsError('invalid-argument', '계정 정지 정보가 올바르지 않습니다.');
  if (uid === p.uid) throw new HttpsError('failed-precondition', '현재 로그인한 관리자 계정은 이 화면에서 정지할 수 없습니다.');
  if ((await sharedDb().ref(`adminCenter/adminUids/${uid}`).get()).val() === true) throw new HttpsError('failed-precondition', '관리자 계정은 이 화면에서 정지할 수 없습니다.');
  const cleanReason = banned ? safeText(String(reason || ''), 200, true) : '';
  await ensureMessengerBanIndex();
  const path = `bannedAccounts/${uid}/games/${SERVICE_ID}`;
  const ban = banned ? { reason: cleanReason, at: now(), by: p.uid } : null;
  const sourceRef = sharedDb().ref(path);
  if (banned) await sourceRef.set(ban);
  else await sourceRef.remove();

  const indexRef = db().ref(`${ROOT}/admin/banIndex/${uid}`);
  let previouslyIndexed = false;
  const indexResult = await indexRef.transaction((current) => {
    previouslyIndexed = current !== null;
    return ban;
  });
  if (indexResult.committed && previouslyIndexed !== banned) {
    await db().ref(`${ROOT}/admin/activeBanCount`).transaction((current) => Math.max(0, (Number(current) || 0) + (banned ? 1 : -1)));
  }
  await writeAudit(p.uid, banned ? 'account.ban' : 'account.unban', `${uid}${cleanReason ? ` · ${cleanReason}` : ''}`);
  return { banned };
});

const messengerExpireRequests = onSchedule({ schedule: '0 * * * *', timeZone: 'Asia/Seoul', region: 'us-central1' }, async () => {
  const [snap, publicRoomsSnap] = await Promise.all([
    db().ref(`${ROOT}/rooms`).get(),
    db().ref(`${ROOT}/publicRooms`).get(),
  ]);
  const rooms = snap.val() || {};
  const publicRooms = publicRoomsSnap.val() || {};
  const t = now(); const updates = {};
  for (const [roomId, room] of Object.entries(rooms)) {
    if (room && room.meta) {
      const projected = publicRoom(room.meta);
      const currentProjection = publicRooms[roomId] || {};
      if (Object.keys(projected).some((key) => currentProjection[key] !== projected[key]) || Object.keys(currentProjection).some((key) => !(key in projected))) {
        updates[`${ROOT}/publicRooms/${roomId}`] = projected;
      }
    }
    const apps = room && room.applications || {};
    for (const [uid, app] of Object.entries(apps)) {
      if (app && app.status === 'pending' && Number(app.expiresAt) <= t) updates[`${ROOT}/rooms/${roomId}/applications/${uid}/status`] = 'expired';
    }
  }
  for (const roomId of Object.keys(publicRooms)) if (!rooms[roomId] || !rooms[roomId].meta) updates[`${ROOT}/publicRooms/${roomId}`] = null;
  if (Object.keys(updates).length) await db().ref().update(updates);
});

const messengerPurgeExpiredData = onSchedule({ schedule: '0 0 * * *', timeZone: 'Asia/Seoul', region: 'us-central1', secrets: [roomselfAccessKeyId, roomselfSecretAccessKey], timeoutSeconds: 540, memory: '1GiB' }, async () => {
  const t = now(); const cutoff = t - CHAT_RETENTION; const s3 = roomselfS3();
  await cleanMessageArchiveQueue(s3);
  const publicRoomsSnap = await db().ref(`${ROOT}/publicRooms`).get();
  const publicRooms = publicRoomsSnap.val() || {}; const updates = {};
  for (const roomId of new Set([...Object.keys(publicRooms), TEST_ROOM_ID])) {
    const pinnedSnap = await roomRef(roomId).child('meta/pinnedMessage').get();
    const pinned = pinnedSnap.val();
    if (pinned && Number(pinned.messageCreatedAt) <= cutoff) updates[`${ROOT}/rooms/${roomId}/meta/pinnedMessage`] = null;
    const timelineRef = db().ref(`${ROOT}/chat/${roomId}/streamerTimeline`);
    let cursor = null;
    let archiveGeneration = '';
    while (true) {
      if (Object.keys(updates).length) {
        await db().ref().update(updates);
        for (const key of Object.keys(updates)) delete updates[key];
      }
      let query = timelineRef.orderByChild('createdAt').endAt(cutoff);
      if (cursor) query = query.startAfter(cursor.createdAt, cursor.key);
      const page = await query.limitToFirst(ARCHIVE_WRITE_PAGE_SIZE).get();
      if (!page.exists()) break;
      const entries = [];
      let last = null;
      page.forEach((child) => {
        const msg = child.val() || {}; const id = child.key;
        last = { createdAt: Number(msg.createdAt) || 0, key: id };
        entries.push({ id, message: msg });
      });
      const memberCountValue = Number((await roomRef(roomId).child('meta/memberCount').get()).val());
      const hasActiveParticipants = Number.isFinite(memberCountValue) && memberCountValue > 0;
      let pageUpdates;
      if (hasActiveParticipants) {
        if (!archiveGeneration) archiveGeneration = await ensureMessageArchiveGeneration(roomId);
        const archived = await archiveExpiredMessagePage(roomId, archiveGeneration, entries, s3);
        pageUpdates = { ...archived.indexUpdates, ...expiredMessageLivePathUpdates(roomId, entries) };
        for (const { message } of entries) {
          if (message.kind === 'roomself' && message.roomselfImageId) {
            pageUpdates[`${ROOT}/privateImages/${message.roomselfImageId}/archived`] = true;
            pageUpdates[`${archivedRoomselfImagesPath(roomId, archiveGeneration)}/${message.roomselfImageId}`] = true;
          }
        }
      } else pageUpdates = expiredMessageLivePathUpdates(roomId, entries);
      await db().ref().update(pageUpdates);
      cursor = last;
      if (page.numChildren() < ARCHIVE_WRITE_PAGE_SIZE || !cursor) break;
    }
  }
  const reportsSnap = await db().ref(`${ROOT}/reports`).get();
  const reports = reportsSnap.val() || {};
  for (const [id, report] of Object.entries(reports)) if (report && Number(report.retainUntil) < t) {
    updates[`${ROOT}/reports/${id}`] = null; updates[`${ROOT}/reportEvidence/${id}`] = null;
    const evidence = (await db().ref(`${ROOT}/reportEvidence/${id}`).get()).val() || {};
    for (const message of Object.values(evidence)) if (message && message.roomselfImageId) updates[`${ROOT}/privateImageRefs/${message.roomselfImageId}/${id}`] = null;
  }
  if (Object.keys(updates).length) await db().ref().update(updates);
  const today = roomselfDateShard(t);
  const daysSnap = await db().ref(`${ROOT}/privateImageDays`).orderByKey().endAt(today).limitToLast(23).get();
  for (const day of Object.keys(daysSnap.val() || {})) {
    const daySnap = await db().ref(`${ROOT}/privateImageDays/${day}`).get();
    const ids = Object.keys(daySnap.val() || {});
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      for (const id of batch) {
        const ref = db().ref(`${ROOT}/privateImages/${id}`); const image = (await ref.get()).val();
        if (!image || image.archived === true || Number(image.expiresAt) >= t) continue;
        const refs = (await db().ref(`${ROOT}/privateImageRefs/${id}`).get()).val() || {};
        const retained = Object.values(refs).some((until) => Number(until) >= t);
        if (retained) continue;
        if (image.key) await s3.send(new DeleteObjectCommand({ Bucket: ROOMSELF_BUCKET, Key: image.key }));
        await db().ref().update({ [`${ROOT}/privateImages/${id}`]: null, [`${ROOT}/privateImageRefs/${id}`]: null, [`${ROOT}/privateImageDays/${day}/${id}`]: null });
      }
    }
  }
});

const messengerCollectDailyUsageAnalytics = onSchedule({
  schedule: '20 2 * * *',
  timeZone: 'Asia/Seoul',
  region: 'us-central1',
  secrets: [roomselfAccessKeyId, roomselfSecretAccessKey],
  timeoutSeconds: 540,
  memory: '1GiB',
}, async () => {
  const result = await withUsageSnapshotLock(async () => {
    const report = await usageAnalytics.collectUsageSnapshot(roomselfS3(), roomselfSecretAccessKey.value(), {
      logError: (metric, code, message) => logger.warn('Cloud Monitoring 사용량을 읽지 못했습니다.', { metric, code, message: String(message || '').slice(0, 160) }),
    });
    const bytes = await usageAnalytics.writeSnapshot(roomselfS3(), report, roomselfSecretAccessKey.value());
    logger.info('메신저 사용량 정적 집계를 저장했습니다.', { from: report.historyFrom, through: report.historyThrough, bytes });
    return report;
  });
  if (!result.acquired) logger.info('다른 메신저 사용량 집계가 진행 중이어서 이번 실행을 건너뜁니다.');
});

module.exports = {
  messengerGetSession, messengerAdminListTestAccounts, messengerAdminCreateTestAccount, messengerAdminJoinTestRoom, messengerAdminIssueTestAccountToken,
  messengerGetRoomState, messengerListMyRooms, messengerEnsureRoom, messengerAutoCreateVerifiedStreamerRoom, messengerAdminBackfillVerifiedRooms, messengerUpdateRoom, messengerDiscardRoom, messengerApplyToRoom,
  messengerListApplications, messengerListFans, messengerReviewApplication, messengerSetMemberStatus,
  messengerRoomMarketUpdate, messengerSetPinnedMessage, messengerMiniGameUpdate, messengerWatchPartyUpdate,
  messengerSendMessage, messengerLoadArchivedMessages, messengerGetLinkPreview, messengerGetStreamerLiveStatus, messengerSearchStreamerClips, messengerGetGalleryImages, messengerGetGalleryImage, messengerSubmitReport,
  messengerRequestRoomselfUpload, messengerFinalizeRoomselfUpload, messengerGetRoomselfImage,
  messengerAdminGetDashboard, messengerAdminGetReportDetail, messengerAdminUpdateReport, messengerAdminSetBan,
  messengerAdminGetBanStatus, messengerAdminGetReportRoomselfImage, messengerAdminGetVisitorAnalytics, messengerAdminGetUsageAnalytics,
  messengerExpireRequests, messengerPurgeExpiredData, messengerCollectDailyUsageAnalytics,
  messengerScheduleStreamerBroadcastHistory, messengerProcessStreamerBroadcastHistory,
};
