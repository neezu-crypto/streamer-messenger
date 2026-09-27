const crypto = require('crypto');
const { promisify } = require('util');
const { getDatabase } = require('firebase-admin/database');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { getPrincipal, requireAdmin, SERVICE_ID } = require('./auth');

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
const ROOMSELF_UPLOAD_WINDOW = 10 * 60 * 1000;
const ROOMSELF_UPLOADS_PER_WINDOW = 5;
const ROOMSELF_UPLOAD_FINALIZE_TTL = 15 * 60 * 1000;
const ROOMSELF_BUCKET = 'streamer-messenger-private';
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
const roomRef = (roomId) => db().ref(`${ROOT}/rooms/${roomId}`);
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

  // One-time backfill from the shared ecosystem ban tree. Subsequent dashboard
  // reads use only this service-scoped index and counter.
  const bansSnap = await db().ref('bannedAccounts').get();
  const updates = {};
  let count = 0;
  bansSnap.forEach((child) => {
    const ban = child.child(`games/${SERVICE_ID}`).val();
    if (!ban) return;
    updates[`${ROOT}/admin/banIndex/${child.key}`] = ban;
    count += 1;
  });
  const entries = Object.entries(updates);
  for (let offset = 0; offset < entries.length; offset += 400) {
    await db().ref().update(Object.fromEntries(entries.slice(offset, offset + 400)));
  }
  await adminRef.update({ activeBanCount: count, banIndexVersion: 1 });
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

async function applyMessageRate(uid, roomId, text, meta) {
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
    memberCount: meta.visibility === 'private' && !includeOperational ? null : Number(meta.memberCount) || 0,
    updatedAt: Number(meta.updatedAt) || Number(meta.createdAt) || now(),
  };
  if (includeOperational) {
    room.galleryLinked = !!meta.galleryStreamerId;
    room.repeatTextDelaySeconds = Number(meta.repeatTextDelaySeconds) || 0;
    room.repeatLinkDelaySeconds = Number(meta.repeatLinkDelaySeconds) || 0;
  }
  return room;
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

const messengerEnsureRoom = onCall(async (request) => {
  const p = await getPrincipal(request, { requireTrusted: true });
  const roomId = principalRoomId(p);
  if (!roomId) throw new HttpsError('permission-denied', '인증된 스트리머 또는 관리자만 채팅방을 만들 수 있습니다.');
  const ref = roomRef(roomId);
  const current = await ref.child('meta').get();
  if (current.exists() && current.val().ownerUid !== p.uid) throw new HttpsError('already-exists', '이 스트리머 아이디의 채팅방이 이미 존재합니다.');
  if (!current.exists()) {
    const createdAt = now();
    const profile = await profileFor(p.uid);
    const streamerNickname = p.streamer ? p.streamer.nickname : (profile.nickname || '관리자');
    const streamerSoopId = p.streamer ? roomId : profile.soopId;
    const galleryStreamerId = await resolveGalleryStreamerId(streamerSoopId, streamerNickname);
    const meta = { roomId, ownerUid: p.uid, streamerId: p.streamer ? roomId : `admin:${p.uid}`, roomType: p.streamer ? 'streamer' : 'admin', galleryStreamerId: galleryStreamerId || null, streamerNickname, streamerSoopId, streamerAvatarUrl: profile.avatarUrl || '', visibility: 'public', locked: false, memberCount: 0, createdAt, updatedAt: createdAt };
    await db().ref().update({ [`${ROOT}/rooms/${roomId}/meta`]: meta, [`${ROOT}/publicRooms/${roomId}`]: publicRoom(meta) });
    await writeAudit(p.uid, 'room.create', roomId);
    return { room: publicRoom(meta, true), created: true };
  }
  const meta = await syncOwnerRoomAvatar(roomId, p.uid, await streamerAvatar(p.uid), current.val());
  return { room: publicRoom(meta, true), created: false };
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
    Object.keys(members).forEach((uid) => { if (members[uid] && members[uid].status === 'active') updates[`${ROOT}/rooms/${roomId}/members/${uid}/status`] = 'removed'; });
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
  const reports = await db().ref(`${ROOT}/reports`).orderByChild('roomId').equalTo(roomId).get();
  const updates = { [`${ROOT}/rooms/${roomId}`]: null, [`${ROOT}/publicRooms/${roomId}`]: null, [`${ROOT}/chat/${roomId}`]: null };
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
  const uploadWindow = Math.floor(now() / ROOMSELF_UPLOAD_WINDOW);
  const uploadLimitRef = db().ref(`${ROOT}/rateLimits/roomselfUploads/${p.uid}/${uploadWindow}`);
  const uploadCount = await uploadLimitRef.transaction((count) => (Number(count) || 0) < ROOMSELF_UPLOADS_PER_WINDOW ? (Number(count) || 0) + 1 : undefined);
  await db().ref(`${ROOT}/rateLimits/roomselfUploads/${p.uid}/${uploadWindow - 2}`).remove().catch(() => {});
  if (!uploadCount.committed) throw new HttpsError('resource-exhausted', '방셀 업로드는 10분에 5회까지 요청할 수 있습니다. 잠시 후 다시 시도해 주세요.');
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
  if (isOwner && recipientUid) {
    const recipient = await roomRef(roomId).child(`members/${recipientUid}`).get();
    if (!recipient.exists() || recipient.val().status !== 'active') throw new HttpsError('failed-precondition', '참여 중인 팬에게만 다이렉트 메시지를 보낼 수 있습니다.');
  }
  const text = ['image', 'roomself'].includes(kind) ? '' : safeText(data.text, MESSAGE_MAX, true);
  if (!['text', 'image', 'roomself'].includes(kind)) throw new HttpsError('invalid-argument', '메시지 유형이 올바르지 않습니다.');
  if (kind === 'roomself' && (!isOwner || !recipientUid)) throw new HttpsError('permission-denied', '스트리머가 지정한 팬에게만 방셀을 보낼 수 있습니다.');
  await applyMessageRate(p.uid, roomId, text, result.meta);
  const createdAt = now();
  const requestedMessageId = String(data.clientMessageId || '');
  if (requestedMessageId && !/^[A-Za-z0-9_-]{20}$/.test(requestedMessageId)) throw new HttpsError('invalid-argument', '메시지 식별자가 올바르지 않습니다.');
  const messageId = requestedMessageId || db().ref(`${ROOT}/chat/${roomId}/streamerTimeline`).push().key;
  if (requestedMessageId && (await db().ref(`${ROOT}/chat/${roomId}/streamerTimeline/${messageId}`).get()).exists()) {
    throw new HttpsError('already-exists', '메시지가 이미 전송되었습니다. 대화 내용을 새로고침해 주세요.');
  }
  const common = { id: messageId, roomId, senderUid: p.uid, senderRole: isOwner ? 'streamer' : 'fan', createdAt, recipientUid: recipientUid || null };
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
  await ensureMessengerBanIndex();
  const [reportsSnap, auditSnap, banCountSnap] = await Promise.all([
    db().ref(`${ROOT}/reports`).orderByChild('createdAt').limitToLast(100).get(),
    db().ref(`${ROOT}/auditLog`).limitToLast(100).get(),
    db().ref(`${ROOT}/admin/activeBanCount`).get(),
  ]);
  const reports = [];
  reportsSnap.forEach((child) => reports.push({ ...(child.val() || {}), id: child.key }));
  reports.sort((a, b) => b.createdAt - a.createdAt);
  const auditLog = [];
  auditSnap.forEach((child) => auditLog.push({ ...(child.val() || {}), id: child.key }));
  auditLog.sort((a, b) => b.at - a.at);
  return {
    reports,
    auditLog,
    summary: {
      pendingReports: reports.filter((report) => (report.status || 'pending') === 'pending').length,
      activeBans: Number(banCountSnap.val()) || 0,
    },
  };
});

const messengerAdminGetBanStatus = onCall(async (request) => {
  await requireAdmin(request);
  const uid = String((request.data || {}).uid || '').trim();
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(uid)) throw new HttpsError('invalid-argument', '계정 UID를 확인해 주세요.');
  const snap = await db().ref(`bannedAccounts/${uid}/games/${SERVICE_ID}`).get();
  return { uid, ban: snap.val() || null };
});

const messengerAdminGetReportDetail = onCall(async (request) => {
  await requireAdmin(request);
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
  return { report, evidence };
});

const messengerAdminGetReportRoomselfImage = onCall({ secrets: [roomselfAccessKeyId, roomselfSecretAccessKey] }, async (request) => {
  await requireAdmin(request);
  const { reportId, imageId } = request.data || {};
  const report = (await db().ref(`${ROOT}/reports/${String(reportId || '')}`).get()).val() || {};
  const retainUntil = Number(report.retainUntil);
  if (!report.id || !Number.isFinite(retainUntil) || retainUntil <= now()) throw new HttpsError('not-found', '신고 증거 보관 기간이 끝났습니다.');
  if (!await db().ref(`${ROOT}/privateImageRefs/${String(imageId || '')}/${String(reportId || '')}`).get().then((s) => s.exists())) throw new HttpsError('permission-denied', '이 신고에 포함된 이미지가 아닙니다.');
  const record = (await db().ref(`${ROOT}/privateImages/${String(imageId || '')}`).get()).val() || {};
  if (record.status !== 'sent' || record.roomId !== report.roomId) throw new HttpsError('not-found', '신고 이미지를 찾을 수 없습니다.');
  const object = await roomselfS3().send(new GetObjectCommand({ Bucket: ROOMSELF_BUCKET, Key: record.key }));
  const bytes = await object.Body.transformToByteArray();
  return { contentType: record.contentType, data: Buffer.from(bytes).toString('base64') };
});

const messengerAdminUpdateReport = onCall(async (request) => {
  const p = await requireAdmin(request);
  const { reportId, status } = request.data || {};
  if (typeof reportId !== 'string' || !['reviewed', 'dismissed'].includes(status)) throw new HttpsError('invalid-argument', '신고 처리 정보가 올바르지 않습니다.');
  const ref = db().ref(`${ROOT}/reports/${reportId}`);
  const snap = await ref.get();
  if (!snap.exists()) throw new HttpsError('not-found', '신고를 찾을 수 없습니다.');
  await ref.update({ status, reviewedAt: now(), reviewedBy: p.uid });
  await writeAudit(p.uid, `report.${status}`, reportId);
  return { status };
});

const messengerAdminSetBan = onCall(async (request) => {
  const p = await requireAdmin(request);
  const { uid, banned, reason } = request.data || {};
  if (typeof uid !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(uid) || typeof banned !== 'boolean') throw new HttpsError('invalid-argument', '계정 정지 정보가 올바르지 않습니다.');
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
  messengerGetSession, messengerGetRoomState, messengerEnsureRoom, messengerUpdateRoom, messengerDiscardRoom, messengerApplyToRoom,
  messengerListApplications, messengerListFans, messengerReviewApplication, messengerSetMemberStatus,
  messengerSendMessage, messengerGetGalleryImages, messengerGetGalleryImage, messengerSubmitReport,
  messengerRequestRoomselfUpload, messengerFinalizeRoomselfUpload, messengerGetRoomselfImage,
  messengerAdminGetDashboard, messengerAdminGetReportDetail, messengerAdminUpdateReport, messengerAdminSetBan,
  messengerAdminGetBanStatus, messengerAdminGetReportRoomselfImage,
  messengerExpireRequests, messengerPurgeExpiredData,
};
