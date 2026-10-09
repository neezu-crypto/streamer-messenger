const crypto = require('crypto');
const dns = require('node:dns').promises;
const https = require('node:https');
const net = require('node:net');
const { promisify } = require('util');
const { getDatabase } = require('firebase-admin/database');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onValueWritten } = require('firebase-functions/v2/database');
const logger = require('firebase-functions/logger');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { getPrincipal, getVerifiedStreamer, requireAdmin, SERVICE_ID } = require('./auth');

const scrypt = promisify(crypto.scrypt);
const ROOT = 'streamerMessenger';
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
const R2_ACCOUNT_ID = '8fe39a69fb377472a64192f9c1b4666e';
const roomselfAccessKeyId = defineSecret('MESSENGER_R2_ACCESS_KEY_ID');
const roomselfSecretAccessKey = defineSecret('MESSENGER_R2_SECRET_ACCESS_KEY');

const db = () => getDatabase();
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
const roomselfS3 = () => new S3Client({ region: 'auto', endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, credentials: { accessKeyId: roomselfAccessKeyId.value(), secretAccessKey: roomselfSecretAccessKey.value() } });
const roomselfKey = (id, ext) => `roomself/${id.slice(0, 2)}/${id}.${ext}`;
const roomselfDateShard = (time) => new Date(time).toISOString().slice(0, 10).replaceAll('-', '');
function roomselfBytesMatchType(bytes, contentType) {
  if (contentType === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (contentType === 'image/png') return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (contentType === 'image/webp') return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (contentType === 'image/gif') return ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6));
  return false;
}

async function profileFor(uid) {
  const snap = await db().ref(`gallery/profiles/${uid}`).get();
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
    const source = db().ref('bannedAccounts').orderByKey();
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
    await db().ref(`${ROOT}/rateLimits/messages/${uid}/minute`).child(String(slot - 2)).remove().catch(() => {});
  }
  // Owners can send rapid updates; room-configured repeated text/link limits still apply.
  await checkRepeatedMessage(uid, roomId, text, Number(meta.repeatTextDelaySeconds) || 0, Number(meta.repeatLinkDelaySeconds) || 0);
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
    const byId = await db().ref(`streamerNames/${normalizedId}`).get();
    if (byId.exists()) return normalizedId;
  }
  const wanted = String(streamerNickname || '').trim().toLocaleLowerCase();
  if (!wanted) return '';
  const snap = await db().ref('streamerNames').get();
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

const messengerGetSession = onCall(async (request) => {
  const p = await getPrincipal(request);
  const profile = p.trusted ? await profileFor(p.uid) : null;
  let ownRoom = null;
  const ownRoomId = principalRoomId(p);
  if (ownRoomId) {
    const snap = await roomRef(ownRoomId).child('meta').get();
    if (snap.exists() && snap.val().ownerUid === p.uid) {
      const meta = await syncOwnerRoomAvatar(ownRoomId, p.uid, profile && profile.avatarUrl, snap.val());
      ownRoom = publicRoom(meta, true);
    }
  }
  return { uid: p.uid, trusted: p.trusted, isRealAccount: p.real, isAdmin: p.admin, isVerifiedStreamer: !!p.streamer, streamer: p.streamer, profile, ownRoom };
});

const messengerGetRoomState = onCall(async (request) => {
  const p = await getPrincipal(request, { requireTrusted: true });
  const roomId = String((request.data || {}).roomId || '');
  if (!/^[a-z0-9]{2,30}$/.test(roomId)) throw new HttpsError('invalid-argument', '채팅방 정보가 올바르지 않습니다.');
  const [metaSnap, memberSnap, applicationSnap, blockedSnap] = await Promise.all([
    roomRef(roomId).child('meta').get(), roomRef(roomId).child(`members/${p.uid}`).get(),
    roomRef(roomId).child(`applications/${p.uid}`).get(), roomRef(roomId).child(`blocked/${p.uid}`).get(),
  ]);
  if (!metaSnap.exists()) throw new HttpsError('not-found', '채팅방을 찾을 수 없습니다.');
  let meta = metaSnap.val() || {};
  if (meta.ownerUid === p.uid) meta = await syncOwnerRoomAvatar(roomId, p.uid, (await profileFor(p.uid)).avatarUrl, meta);
  return { room: publicRoom(meta, meta.ownerUid === p.uid), isOwner: meta.ownerUid === p.uid, member: memberSnap.val() || null, application: applicationSnap.val() || null, blocked: blockedSnap.exists() };
});

const messengerListMyRooms = onCall({ timeoutSeconds: 120 }, async (request) => {
  const p = await getPrincipal(request, { requireTrusted: true });
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
const messengerAutoCreateVerifiedStreamerRoom = onValueWritten('/streamerVerifications/{recordId}', { retry: true }, async (event) => {
  const before = event.data.before.val() || null;
  const after = event.data.after.val() || null;
  if (!after || !after.uid) return null;
  if (before && before.uid === after.uid && before.nickname === after.nickname && before.soopId === after.soopId) return null;

  const uid = String(after.uid);
  const recordRef = db().ref(`streamerVerifications/${event.params.recordId}`);
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
    if (Number(value.version) >= 1 || (value.status === 'running' && now() - Number(value.startedAt || 0) < 10 * 60 * 1000)) return;
    return { status: 'running', startedAt: now(), startedBy: admin.uid };
  }, undefined, false);
  if (!lock.committed) {
    const current = lock.snapshot.val() || {};
    return { complete: Number(current.version) >= 1, inProgress: current.status === 'running', created: 0, existing: 0, skipped: 0 };
  }

  try {
    const records = await db().ref('streamerVerifications').get();
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

    await statusRef.set({ version: 1, status: 'complete', startedAt: Number(lock.snapshot.val().startedAt) || now(), completedAt: now(), completedBy: admin.uid, ...summary });
    return { complete: true, ...summary };
  } catch (error) {
    await statusRef.set({ version: 0, status: 'failed', failedAt: now(), failedBy: admin.uid, errorCode: String(error && error.code || 'unknown').slice(0, 80) });
    throw error;
  }
});

const messengerUpdateRoom = onCall(async (request) => {
  const p = await getPrincipal(request, { requireTrusted: true });
  const { roomId, visibility, password, regeneratePassword, locked, memberPolicy } = request.data || {};
  const data = request.data || {};
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
  updates[`${ROOT}/publicRooms/${roomId}`] = publicRoom(nextMeta);
  await db().ref().update(updates);
  await writeAudit(p.uid, 'room.update', roomId);
  return { room: publicRoom(nextMeta, true), generatedPassword: generatedPassword || null };
});

const messengerDiscardRoom = onCall(async (request) => {
  const p = await getPrincipal(request, { requireTrusted: true });
  const roomId = String((request.data || {}).roomId || '');
  const { meta, isOwner } = await requireRoomMember(p, roomId);
  if (!isOwner) throw new HttpsError('permission-denied', '채팅방 소유자만 방을 폐기할 수 있습니다.');
  const [reports, membersSnap] = await Promise.all([
    db().ref(`${ROOT}/reports`).orderByChild('roomId').equalTo(roomId).get(),
    roomRef(roomId).child('members').get(),
  ]);
  const updates = { [`${ROOT}/rooms/${roomId}`]: null, [`${ROOT}/publicRooms/${roomId}`]: null, [`${ROOT}/chat/${roomId}`]: null, [`${ROOT}/roomMarkets/${roomId}`]: null };
  membersSnap.forEach((child) => { if (child.key) updates[userRoomIndexPath(child.key, roomId)] = null; });
  reports.forEach((child) => {
    const report = child.val() || {};
    if (Number(report.retainUntil) < now()) {
      updates[`${ROOT}/reports/${child.key}`] = null;
      updates[`${ROOT}/reportEvidence/${child.key}`] = null;
    }
  });
  await db().ref().update(updates);
  await writeAudit(p.uid, 'room.discard', roomId);
  return { discarded: true, streamerNickname: meta.streamerNickname };
});

const messengerApplyToRoom = onCall(async (request) => {
  const p = await getPrincipal(request, { requireTrusted: true });
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
  const p = await getPrincipal(request, { requireTrusted: true });
  const roomId = String((request.data || {}).roomId || '');
  const result = await requireRoomMember(p, roomId);
  if (!result.isOwner) throw new HttpsError('permission-denied', '스트리머만 신청 목록을 확인할 수 있습니다.');
  const snap = await roomRef(roomId).child('applications').get();
  const items = Object.values(snap.val() || {}).filter((item) => item && item.status === 'pending');
  return { applications: items.sort((a, b) => a.submittedAt - b.submittedAt) };
});

const messengerListFans = onCall(async (request) => {
  const p = await getPrincipal(request, { requireTrusted: true });
  const roomId = String((request.data || {}).roomId || '');
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
  const p = await getPrincipal(request, { requireTrusted: true });
  const { roomId, uid, decision } = request.data || {};
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
    updates[`${ROOT}/publicRooms/${roomId}/memberCount`] = (Number(result.meta.memberCount) || 0) + 1;
  } else updates[`${ROOT}/rooms/${roomId}/applications/${uid}/reapplyAt`] = at + APPLICATION_EXPIRE;
  await db().ref().update(updates);
  return { status: decision };
});

const messengerSetMemberStatus = onCall(async (request) => {
  const p = await getPrincipal(request, { requireTrusted: true });
  const { roomId, uid, status } = request.data || {};
  const result = await requireRoomMember(p, String(roomId || ''));
  if (!result.isOwner || typeof uid !== 'string' || !['blocked', 'active'].includes(status)) throw new HttpsError('permission-denied', '요청을 처리할 수 없습니다.');
  const memberSnap = await roomRef(roomId).child(`members/${uid}`).get();
  const updates = {};
  updates[`${ROOT}/rooms/${roomId}/members/${uid}/status`] = status;
  updates[`${ROOT}/rooms/${roomId}/members/${uid}/updatedAt`] = now();
  updates[userRoomIndexPath(uid, roomId)] = null;
  if (status === 'blocked') {
    updates[`${ROOT}/rooms/${roomId}/blocked/${uid}`] = { at: now(), by: p.uid };
    updates[`${ROOT}/rooms/${roomId}/meta/memberCount`] = Math.max(0, (Number(result.meta.memberCount) || 0) - (memberSnap.val() && memberSnap.val().status === 'active' ? 1 : 0));
    updates[`${ROOT}/publicRooms/${roomId}/memberCount`] = Math.max(0, (Number(result.meta.memberCount) || 0) - (memberSnap.val() && memberSnap.val().status === 'active' ? 1 : 0));
  } else {
    updates[`${ROOT}/rooms/${roomId}/blocked/${uid}`] = null;
    updates[`${ROOT}/rooms/${roomId}/members/${uid}`] = null;
  }
  await db().ref().update(updates);
  await writeAudit(p.uid, `member.${status}`, `${roomId}/${uid}`);
  return { status };
});

const ROOM_MARKET_STOCK_LIMIT = 12;
const messengerRoomMarketUpdate = onCall(async (request) => {
  const p = await getPrincipal(request, { requireTrusted: true });
  const { roomId: rawRoomId, stockId: rawStockId, action } = request.data || {};
  const roomId = String(rawRoomId || '');
  const stockId = String(rawStockId || '');
  if (!['add', 'remove'].includes(action)) throw new HttpsError('invalid-argument', '요청이 올바르지 않습니다.');
  if (!/^[a-z0-9]{2,30}$/.test(roomId)) throw new HttpsError('invalid-argument', '채팅방 정보가 올바르지 않습니다.');
  const { isOwner } = await requireRoomMember(p, roomId);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(stockId)) throw new HttpsError('invalid-argument', '종목 정보가 올바르지 않습니다.');
  const stocksRef = db().ref(`${ROOT}/roomMarkets/${roomId}/stocks`);

  if (action === 'remove') {
    if (!isOwner) throw new HttpsError('permission-denied', '스트리머만 공유 종목을 제거할 수 있습니다.');
    await stocksRef.child(stockId).remove();
    try { await writeAudit(p.uid, 'roomMarket.stock.remove', `${roomId}/${stockId}`); }
    catch (error) { logger.warn('공유 종목 제거 감사 기록 실패', error); }
    return { action, removed: true };
  }

  const publicStockSnap = await db().ref(`stocksPublic/${stockId}`).get();
  const stockSnap = await db().ref(`stocks/${stockId}`).get();
  if (!publicStockSnap.exists() || !stockSnap.exists()) throw new HttpsError('not-found', '현재 거래할 수 있는 종목이 아닙니다.');
  const stock = publicStockSnap.val() || {};
  const addedAt = now();
  let alreadyAdded = false;
  const result = await stocksRef.transaction((current) => {
    const stocks = current || {};
    alreadyAdded = Object.prototype.hasOwnProperty.call(stocks, stockId);
    if (alreadyAdded) return stocks;
    if (Object.keys(stocks).length >= ROOM_MARKET_STOCK_LIMIT) return;
    return { ...stocks, [stockId]: { stockId, name: String(stock.name || stockId).slice(0, 80), addedAt } };
  });
  if (!result.committed) throw new HttpsError('resource-exhausted', `채팅방에는 종목을 최대 ${ROOM_MARKET_STOCK_LIMIT}개까지 공유할 수 있습니다.`);
  try { await writeAudit(p.uid, 'roomMarket.stock.add', `${roomId}/${stockId}`); }
  catch (error) { logger.warn('공유 종목 추가 감사 기록 실패', error); }
  return { action, stock: result.snapshot.child(stockId).val(), alreadyAdded };
});

const messengerSetPinnedMessage = onCall({ maxInstances: 20 }, async (request) => {
  const p = await getPrincipal(request, { requireTrusted: true });
  const data = request.data || {};
  const roomId = String(data.roomId || '');
  const messageId = data.messageId;
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

function ladderResultText(game) {
  const players = Array.isArray(game.players) ? game.players.map((value) => safeText(value, 24, true)) : [];
  const outcomes = Array.isArray(game.outcomes) ? game.outcomes.map((value) => safeText(value, 24, true)) : [];
  const rungs = Array.isArray(game.rungs) ? game.rungs.slice(0, LADDER_ROW_COUNT).map((row) => Array.isArray(row) ? row : []) : [];
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
  return `사다리타기 결과: ${pairs.join(' · ')}`;
}

const messengerMiniGameUpdate = onCall({ maxInstances: 20 }, async (request) => {
  const p = await getPrincipal(request, { requireTrusted: true });
  const data = request.data || {};
  const roomId = String(data.roomId || '');
  const action = String(data.action || '');
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
    const active = current && current.gameType === 'ladder' && current.status === 'active'
      && Number.isFinite(Number(current.expiresAt)) && Number(current.expiresAt) > now()
      && Array.isArray(current.players) && Array.isArray(current.outcomes) && Array.isArray(current.rungs)
      ? current : null;
    return { miniGame: active };
  }
  if (action === 'select') {
    const gameId = String(data.gameId || '');
    const participantIndex = Number(data.participantIndex);
    if (!/^[a-f0-9]{24}$/.test(gameId) || !Number.isInteger(participantIndex) || participantIndex < 0 || participantIndex >= LADDER_PLAYER_LIMIT) {
      throw new HttpsError('invalid-argument', '선택한 사다리 참가자 정보가 올바르지 않습니다.');
    }
    const selected = await gameRef.transaction((current) => {
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
    if (current && current.gameType === 'ladder' && current.status === 'active' && Number(current.expiresAt) > createdAt) return;
    return miniGame;
  });
  if (!started.committed) throw new HttpsError('already-exists', '이 채팅방에서 진행 중인 미니게임이 있습니다.');
  return { miniGame: started.snapshot.val() };
});

async function galleryImageForChat(roomId, imageId) {
  const rawMeta = (await roomRef(roomId).child('meta').get()).val() || {};
  const meta = await ensureGalleryLink(roomId, rawMeta);
  if (!meta.galleryStreamerId) throw new HttpsError('failed-precondition', '인증된 스트리머 닉네임과 갤러리 스트리머를 연결할 수 없습니다. 갤러리의 스트리머 이름을 확인해 주세요.');
  const imageSnap = await db().ref(`gallery/imagesPublic/${imageId}`).get();
  if (!imageSnap.exists()) throw new HttpsError('not-found', '갤러리 이미지가 없거나 삭제되었습니다.');
  const image = imageSnap.val() || {};
  if (String(image.streamerId || '') !== String(meta.galleryStreamerId || '')) throw new HttpsError('permission-denied', '이 채팅방 스트리머의 갤러리 이미지만 보낼 수 있습니다.');
  const [firstUpload, unlockedUntil] = await Promise.all([
    db().ref(`gallery/streamerFirstUpload/${meta.galleryStreamerId}`).get(),
    db().ref(`gallery/streamerUnlockedUntil/${meta.galleryStreamerId}`).get(),
  ]);
  const first = Number(firstUpload.val()) || 0;
  const until = Number(unlockedUntil.val()) || 0;
  const unlocked = (first > 0 && now() < first + 30 * 24 * 60 * 60 * 1000) || (until > 0 && now() < until);
  if (!unlocked) throw new HttpsError('failed-precondition', '갤러리 열람 기간이 끝났습니다. 먼저 스트리머 갤러리에서 해금해 주세요.');
  return { imageId, streamerId: image.streamerId, thumbUrl: image.thumbUrl || '', imageUrl: image.imageUrl || '', width: image.width || null, height: image.height || null, createdAt: image.createdAt || 0 };
}

const messengerGetGalleryImages = onCall(async (request) => {
  const p = await getPrincipal(request, { requireTrusted: true });
  const roomId = String((request.data || {}).roomId || '');
  const { meta: rawMeta } = await requireRoomMember(p, roomId);
  const meta = await ensureGalleryLink(roomId, rawMeta);
  if (!meta.galleryStreamerId) return { locked: false, linked: false, streamerId: '', images: [] };
  const [firstUpload, unlockedUntil] = await Promise.all([
    db().ref(`gallery/streamerFirstUpload/${meta.galleryStreamerId}`).get(),
    db().ref(`gallery/streamerUnlockedUntil/${meta.galleryStreamerId}`).get(),
  ]);
  const first = Number(firstUpload.val()) || 0;
  const until = Number(unlockedUntil.val()) || 0;
  const unlocked = (first > 0 && now() < first + 30 * 24 * 60 * 60 * 1000) || (until > 0 && now() < until);
  if (!unlocked) {
    const hasImages = (await db().ref('gallery/imagesPublic').orderByChild('streamerId').equalTo(meta.galleryStreamerId).limitToFirst(1).get()).exists();
    if (hasImages) return { locked: true, linked: true, streamerId: meta.galleryStreamerId, images: [] };
    return { locked: false, linked: true, streamerId: meta.galleryStreamerId, images: [] };
  }
  const snap = await db().ref('gallery/imagesPublic').orderByChild('streamerId').equalTo(meta.galleryStreamerId).limitToLast(100).get();
  const images = [];
  snap.forEach((child) => { const image = child.val() || {}; images.push({ imageId: child.key, thumbUrl: image.thumbUrl || '', imageUrl: image.imageUrl || '', createdAt: image.createdAt || 0, width: image.width || null, height: image.height || null }); });
  images.sort((a, b) => b.createdAt - a.createdAt);
  return { locked: false, linked: true, streamerId: meta.galleryStreamerId, images };
});

const messengerGetGalleryImage = onCall(async (request) => {
  const p = await getPrincipal(request, { requireTrusted: true });
  const { roomId, imageId } = request.data || {};
  await requireRoomMember(p, String(roomId || ''));
  return await galleryImageForChat(String(roomId), String(imageId || ''));
});

const messengerRequestRoomselfUpload = onCall({ secrets: [roomselfAccessKeyId, roomselfSecretAccessKey], maxInstances: 20 }, async (request) => {
  const p = await getPrincipal(request, { requireTrusted: true });
  const { roomId, recipientUid, contentType, size } = request.data || {};
  const room = String(roomId || ''); const recipient = String(recipientUid || '');
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
  const p = await getPrincipal(request, { requireTrusted: true });
  const imageId = String((request.data || {}).imageId || '');
  if (!/^[a-f0-9]{32}$/.test(imageId)) throw new HttpsError('invalid-argument', '이미지 정보가 올바르지 않습니다.');
  const ref = db().ref(`${ROOT}/privateImages/${imageId}`); const snap = await ref.get(); const record = snap.val() || {};
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
  const p = await getPrincipal(request, { requireTrusted: true });
  const { roomId, imageId } = request.data || {}; const room = String(roomId || ''); const id = String(imageId || '');
  const { meta, isOwner, member } = await requireRoomMember(p, room);
  const snap = await db().ref(`${ROOT}/privateImages/${id}`).get(); const record = snap.val() || {};
  const allowed = isOwner && record.ownerUid === p.uid || record.recipientUid === p.uid && Number(member && member.joinedAt || 0) <= Number(record.sentAt || 0);
  if (!snap.exists() || record.roomId !== room || !allowed || record.status !== 'sent') throw new HttpsError('permission-denied', '이 비공개 이미지를 볼 권한이 없습니다.');
  const recipientMember = (await roomRef(room).child(`members/${record.recipientUid}`).get()).val() || {};
  if (recipientMember.status !== 'active') throw new HttpsError('permission-denied', '대화가 중단된 팬의 이미지는 볼 수 없습니다.');
  if (now() - Number(record.createdAt || 0) > CHAT_RETENTION) throw new HttpsError('not-found', '이미지 보관 기간이 끝났습니다.');
  const msg = (await db().ref(`${ROOT}/chat/${room}/streamerTimeline/${record.messageId}`).get()).val() || {};
  if (msg.kind !== 'roomself' || msg.roomselfImageId !== id || msg.recipientUid !== record.recipientUid || msg.senderUid !== record.ownerUid) throw new HttpsError('not-found', '이미지를 찾을 수 없습니다.');
  const object = await roomselfS3().send(new GetObjectCommand({ Bucket: ROOMSELF_BUCKET, Key: record.key }));
  const bytes = await object.Body.transformToByteArray();
  if (bytes.byteLength > ROOMSELF_MAX_BYTES) throw new HttpsError('resource-exhausted', '이미지 용량 제한을 초과했습니다.');
  return { contentType: record.contentType, data: Buffer.from(bytes).toString('base64'), streamerName: meta.streamerNickname || '' };
});

const messengerGetLinkPreview = onCall({ maxInstances: 10 }, async (request) => {
  const principal = await getPrincipal(request, { requireTrusted: true });
  const data = request.data || {};
  const roomId = String(data.roomId || '');
  await requireRoomMember(principal, roomId);
  const url = safeText(String(data.url || ''), 2048, true);
  return getLinkPreview(url);
});

const messengerSendMessage = onCall({ maxInstances: 30 }, async (request) => {
  const p = await getPrincipal(request, { requireTrusted: true });
  const data = request.data || {};
  const roomId = String(data.roomId || '');
  const result = await requireRoomMember(p, roomId);
  if (!result.isOwner && result.meta.locked) throw new HttpsError('failed-precondition', '채팅방이 잠겨 있어 스트리머만 메시지를 보낼 수 있습니다.');
  const member = result.member || {};
  const isOwner = result.isOwner;
  const kind = String(data.kind || 'text');
  const recipientUid = isOwner && data.recipientUid ? String(data.recipientUid) : '';
  let recipientName = '';
  if (isOwner && recipientUid) {
    const recipient = await roomRef(roomId).child(`members/${recipientUid}`).get();
    if (!recipient.exists() || recipient.val().status !== 'active') throw new HttpsError('failed-precondition', '참여 중인 팬에게만 다이렉트 메시지를 보낼 수 있습니다.');
    recipientName = String(recipient.val().profile && recipient.val().profile.nickname || '팬').slice(0, 30);
  }
  const text = ['image', 'roomself'].includes(kind) ? '' : safeText(data.text, MESSAGE_MAX, true);
  if (!['text', 'image', 'roomself'].includes(kind)) throw new HttpsError('invalid-argument', '메시지 유형이 올바르지 않습니다.');
  if (kind === 'roomself' && (!isOwner || !recipientUid)) throw new HttpsError('permission-denied', '스트리머가 지정한 팬에게만 방셀을 보낼 수 있습니다.');
  await applyMessageRate(p.uid, roomId, text, result.meta, isOwner);
  const createdAt = now();
  const requestedMessageId = String(data.clientMessageId || '');
  if (requestedMessageId && !/^[A-Za-z0-9_-]{20}$/.test(requestedMessageId)) throw new HttpsError('invalid-argument', '메시지 식별자가 올바르지 않습니다.');
  const messageId = requestedMessageId || db().ref(`${ROOT}/chat/${roomId}/streamerTimeline`).push().key;
  if (requestedMessageId && (await db().ref(`${ROOT}/chat/${roomId}/streamerTimeline/${messageId}`).get()).exists()) {
    throw new HttpsError('already-exists', '메시지가 이미 전송되었습니다. 대화 내용을 새로고침해 주세요.');
  }
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
  await db().ref().update(updates);
  return { message };
});

const messengerSubmitReport = onCall(async (request) => {
  const p = await getPrincipal(request, { requireTrusted: true });
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
      const imageSnap = await db().ref(`gallery/imagesPublic/${message.galleryImageId}`).get();
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

const messengerAdminGetBanStatus = onCall(async (request) => {
  const p = await requireAdmin(request);
  const uid = String((request.data || {}).uid || '').trim();
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(uid)) throw new HttpsError('invalid-argument', '계정 UID를 확인해 주세요.');
  const [snap, accountSnap] = await Promise.all([
    db().ref(`bannedAccounts/${uid}/games/${SERVICE_ID}`).get(),
    db().ref(`bannedAccounts/${uid}`).get(),
  ]);
  const adminSnap = await db().ref(`adminCenter/adminUids/${uid}`).get();
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
  if ((await db().ref(`adminCenter/adminUids/${uid}`).get()).val() === true) throw new HttpsError('failed-precondition', '관리자 계정은 이 화면에서 정지할 수 없습니다.');
  const cleanReason = banned ? safeText(String(reason || ''), 200, true) : '';
  await ensureMessengerBanIndex();
  const path = `bannedAccounts/${uid}/games/${SERVICE_ID}`;
  const ban = banned ? { reason: cleanReason, at: now(), by: p.uid } : null;
  const sourceRef = db().ref(path);
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

const messengerPurgeExpiredData = onSchedule({ schedule: '0 0 * * *', timeZone: 'Asia/Seoul', region: 'us-central1', secrets: [roomselfAccessKeyId, roomselfSecretAccessKey] }, async () => {
  const t = now(); const cutoff = t - CHAT_RETENTION;
  const publicRoomsSnap = await db().ref(`${ROOT}/publicRooms`).get();
  const publicRooms = publicRoomsSnap.val() || {}; const updates = {};
  for (const roomId of Object.keys(publicRooms)) {
    const pinnedSnap = await roomRef(roomId).child('meta/pinnedMessage').get();
    const pinned = pinnedSnap.val();
    if (pinned && Number(pinned.messageCreatedAt) <= cutoff) updates[`${ROOT}/rooms/${roomId}/meta/pinnedMessage`] = null;
    const timelineRef = db().ref(`${ROOT}/chat/${roomId}/streamerTimeline`);
    let cursor = null;
    while (true) {
      let query = timelineRef.orderByChild('createdAt').endAt(cutoff);
      if (cursor) query = query.startAfter(cursor.createdAt, cursor.key);
      const page = await query.limitToFirst(400).get();
      if (!page.exists()) break;
      let last = null;
      page.forEach((child) => {
        const msg = child.val() || {}; const id = child.key;
        last = { createdAt: Number(msg.createdAt) || 0, key: id };
        updates[`${ROOT}/chat/${roomId}/streamerTimeline/${id}`] = null;
        updates[`${ROOT}/chat/${roomId}/broadcast/${id}`] = null;
        const privateUid = msg.senderRole === 'fan' ? msg.senderUid : msg.recipientUid;
        if (privateUid) updates[`${ROOT}/chat/${roomId}/private/${privateUid}/${id}`] = null;
      });
      cursor = last;
      if (Object.keys(updates).length >= 900) { await db().ref().update(updates); for (const key of Object.keys(updates)) delete updates[key]; }
      if (page.numChildren() < 400 || !cursor) break;
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
  const s3 = roomselfS3();
  for (const day of Object.keys(daysSnap.val() || {})) {
    const daySnap = await db().ref(`${ROOT}/privateImageDays/${day}`).get();
    const ids = Object.keys(daySnap.val() || {});
    for (let i = 0; i < ids.length; i += 100) {
      const batch = ids.slice(i, i + 100);
      for (const id of batch) {
        const ref = db().ref(`${ROOT}/privateImages/${id}`); const image = (await ref.get()).val();
        if (!image || Number(image.expiresAt) >= t) continue;
        const refs = (await db().ref(`${ROOT}/privateImageRefs/${id}`).get()).val() || {};
        const retained = Object.values(refs).some((until) => Number(until) >= t);
        if (retained) continue;
        if (image.key) await s3.send(new DeleteObjectCommand({ Bucket: ROOMSELF_BUCKET, Key: image.key }));
        await db().ref().update({ [`${ROOT}/privateImages/${id}`]: null, [`${ROOT}/privateImageRefs/${id}`]: null, [`${ROOT}/privateImageDays/${day}/${id}`]: null });
      }
    }
  }
});

module.exports = {
  messengerGetSession, messengerGetRoomState, messengerListMyRooms, messengerEnsureRoom, messengerAutoCreateVerifiedStreamerRoom, messengerAdminBackfillVerifiedRooms, messengerUpdateRoom, messengerDiscardRoom, messengerApplyToRoom,
  messengerListApplications, messengerListFans, messengerReviewApplication, messengerSetMemberStatus,
  messengerRoomMarketUpdate, messengerSetPinnedMessage, messengerMiniGameUpdate,
  messengerSendMessage, messengerGetLinkPreview, messengerGetGalleryImages, messengerGetGalleryImage, messengerSubmitReport,
  messengerRequestRoomselfUpload, messengerFinalizeRoomselfUpload, messengerGetRoomselfImage,
  messengerAdminGetDashboard, messengerAdminGetReportDetail, messengerAdminUpdateReport, messengerAdminSetBan,
  messengerAdminGetBanStatus, messengerAdminGetReportRoomselfImage,
  messengerExpireRequests, messengerPurgeExpiredData,
};
