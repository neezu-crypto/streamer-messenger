const crypto = require('crypto');
const { promisify } = require('util');
const { getDatabase } = require('firebase-admin/database');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { getPrincipal, requireAdmin, SERVICE_ID } = require('./auth');

const scrypt = promisify(crypto.scrypt);
const ROOT = 'streamerMessenger';
const MESSAGE_MAX = 1000;
const INTRO_MAX = 500;
const APPLICATION_INTERVAL = 5 * 60 * 1000;
const APPLICATION_EXPIRE = 3 * 24 * 60 * 60 * 1000;
const MESSAGE_COOLDOWN = 2000;
const MESSAGE_LIMIT_PER_MINUTE = 20;
const CHAT_RETENTION = 7 * 24 * 60 * 60 * 1000;
const REPORT_RETENTION = 14 * 24 * 60 * 60 * 1000;

const db = () => getDatabase();
const now = () => Date.now();
const safeText = (value, max, required = false) => {
  if (typeof value !== 'string') throw new HttpsError('invalid-argument', '입력값이 올바르지 않습니다.');
  const text = value.trim();
  if ((required && !text) || text.length > max || /[<>\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(text)) {
    throw new HttpsError('invalid-argument', '입력 내용을 확인해 주세요.');
  }
  return text;
};
const roomRef = (roomId) => db().ref(`${ROOT}/rooms/${roomId}`);

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

async function applyMessageRate(uid) {
  const lastRef = db().ref(`${ROOT}/rateLimits/messages/${uid}/lastAt`);
  const result = await lastRef.transaction((last) => {
    const t = now();
    if (last && t - last < MESSAGE_COOLDOWN) return;
    return t;
  });
  if (!result.committed) throw new HttpsError('resource-exhausted', '메시지는 2초에 한 번씩 보낼 수 있습니다.');
  const slot = Math.floor(now() / 60000);
  const countRef = db().ref(`${ROOT}/rateLimits/messages/${uid}/minute/${slot}`);
  const count = await countRef.transaction((value) => (Number(value) || 0) < MESSAGE_LIMIT_PER_MINUTE ? (Number(value) || 0) + 1 : undefined);
  if (!count.committed) throw new HttpsError('resource-exhausted', '1분 메시지 제한에 도달했습니다. 잠시 후 다시 시도해 주세요.');
  await db().ref(`${ROOT}/rateLimits/messages/${uid}/minute`).child(String(slot - 2)).remove().catch(() => {});
}

async function streamerAvatar(uid) {
  const p = await profileFor(uid);
  return p.avatarUrl || '';
}

function publicRoom(meta) {
  return {
    roomId: meta.roomId,
    streamerNickname: meta.streamerNickname,
    streamerSoopId: meta.streamerSoopId,
    streamerAvatarUrl: meta.streamerAvatarUrl || '',
    galleryLinked: !!meta.galleryStreamerId,
    visibility: meta.visibility || 'public',
    locked: meta.locked === true,
    memberCount: Number(meta.memberCount) || 0,
    updatedAt: Number(meta.updatedAt) || Number(meta.createdAt) || now(),
  };
}

async function resolveGalleryStreamerId(streamerNickname) {
  const wanted = String(streamerNickname || '').trim().toLocaleLowerCase();
  if (!wanted) return '';
  const snap = await db().ref('streamerNames').get();
  const matches = [];
  snap.forEach((child) => {
    if (String(child.val() || '').trim().toLocaleLowerCase() === wanted) matches.push(child.key);
  });
  return matches.length === 1 ? matches[0] : '';
}

const messengerGetSession = onCall(async (request) => {
  const p = await getPrincipal(request);
  const profile = p.trusted ? await profileFor(p.uid) : null;
  let ownRoom = null;
  if (p.streamer && p.streamer.soopId) {
    const snap = await roomRef(p.streamer.soopId).child('meta').get();
    if (snap.exists() && snap.val().ownerUid === p.uid) ownRoom = publicRoom(snap.val());
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
  const meta = metaSnap.val() || {};
  return { room: publicRoom(meta), isOwner: meta.ownerUid === p.uid, member: memberSnap.val() || null, application: applicationSnap.val() || null, blocked: blockedSnap.exists() };
});

const messengerEnsureRoom = onCall(async (request) => {
  const p = await getPrincipal(request, { requireTrusted: true });
  if (!p.streamer || !p.streamer.soopId || !/^[a-z0-9]{2,30}$/.test(p.streamer.soopId)) throw new HttpsError('permission-denied', '인증된 스트리머만 채팅방을 만들 수 있습니다.');
  const roomId = p.streamer.soopId;
  const ref = roomRef(roomId);
  const current = await ref.child('meta').get();
  if (current.exists() && current.val().ownerUid !== p.uid) throw new HttpsError('already-exists', '이 스트리머 아이디의 채팅방이 이미 존재합니다.');
  if (!current.exists()) {
    const createdAt = now();
    const galleryStreamerId = await resolveGalleryStreamerId(p.streamer.nickname);
    const meta = { roomId, ownerUid: p.uid, streamerId: roomId, galleryStreamerId: galleryStreamerId || null, streamerNickname: p.streamer.nickname, streamerSoopId: roomId, streamerAvatarUrl: await streamerAvatar(p.uid), visibility: 'public', locked: false, memberCount: 0, createdAt, updatedAt: createdAt };
    await db().ref().update({ [`${ROOT}/rooms/${roomId}/meta`]: meta, [`${ROOT}/publicRooms/${roomId}`]: publicRoom(meta) });
    await writeAudit(p.uid, 'room.create', roomId);
    return { room: publicRoom(meta), created: true };
  }
  return { room: publicRoom(current.val()), created: false };
});

const messengerUpdateRoom = onCall(async (request) => {
  const p = await getPrincipal(request, { requireTrusted: true });
  const { roomId, visibility, password, regeneratePassword, locked, memberPolicy } = request.data || {};
  const result = await requireRoomMember(p, String(roomId || ''));
  if (!result.isOwner) throw new HttpsError('permission-denied', '채팅방 소유자만 설정을 변경할 수 있습니다.');
  if (!['public', 'private'].includes(visibility)) throw new HttpsError('invalid-argument', '방 공개 설정이 올바르지 않습니다.');
  const meta = result.meta;
  const metaPatch = { visibility, locked: locked === true, updatedAt: now() };
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
  return { room: publicRoom(nextMeta), generatedPassword: generatedPassword || null };
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
  const meta = (await roomRef(roomId).child('meta').get()).val() || {};
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
  const { meta } = await requireRoomMember(p, roomId);
  if (!meta.galleryStreamerId) return { locked: false, linked: false, streamerId: '', images: [] };
  const [firstUpload, unlockedUntil] = await Promise.all([
    db().ref(`gallery/streamerFirstUpload/${meta.galleryStreamerId}`).get(),
    db().ref(`gallery/streamerUnlockedUntil/${meta.galleryStreamerId}`).get(),
  ]);
  const first = Number(firstUpload.val()) || 0;
  const until = Number(unlockedUntil.val()) || 0;
  const unlocked = (first > 0 && now() < first + 30 * 24 * 60 * 60 * 1000) || (until > 0 && now() < until);
  if (!unlocked) return { locked: true, linked: true, streamerId: meta.galleryStreamerId, images: [] };
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

const messengerSendMessage = onCall(async (request) => {
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
  if (!isOwner) await applyMessageRate(p.uid);
  const createdAt = now();
  const messageId = db().ref(`${ROOT}/chat/${roomId}/streamerTimeline`).push().key;
  const common = { id: messageId, roomId, senderUid: p.uid, senderRole: isOwner ? 'streamer' : 'fan', createdAt, recipientUid: recipientUid || null };
  let message;
  if (kind === 'image') {
    const image = await galleryImageForChat(roomId, String(data.galleryImageId || ''));
    message = { ...common, kind: 'image', galleryImageId: image.imageId };
  } else {
    const text = safeText(data.text, MESSAGE_MAX, true);
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
  const { roomId, startAt, endAt, reason } = request.data || {};
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
  const timelineSnap = await db().ref(`${ROOT}/chat/${roomId}/streamerTimeline`).orderByChild('createdAt').startAt(start).endAt(end).limitToLast(500).get();
  const visible = [];
  timelineSnap.forEach((child) => {
    const m = child.val() || {};
    const allowed = isOwner
      ? (m.senderUid === targetUid || m.recipientUid === targetUid || m.senderRole === 'streamer' && (!m.recipientUid || m.recipientUid === targetUid))
      : (m.senderUid === p.uid || m.senderRole === 'streamer' && (!m.recipientUid || m.recipientUid === p.uid));
    if (allowed) visible.push(m);
  });
  if (!visible.length) throw new HttpsError('failed-precondition', '선택 범위에서 신고할 대화를 찾을 수 없습니다.');
  const reportRef = db().ref(`${ROOT}/reports`).push();
  const reportId = reportRef.key;
  const item = { id: reportId, roomId, reporterUid: p.uid, targetUid, streamerId: meta.streamerId, reason: safeText(reason || '기타', 300), status: 'pending', createdAt: at, retainUntil: at + REPORT_RETENTION, rangeStart: start, rangeEnd: end };
  const evidence = {};
  visible.forEach((m) => { evidence[m.id] = m; });
  await db().ref().update({ [`${ROOT}/reports/${reportId}`]: item, [`${ROOT}/reportEvidence/${reportId}`]: evidence });
  await writeAudit(p.uid, 'report.submit', reportId);
  return { reportId };
});

const messengerAdminGetDashboard = onCall(async (request) => {
  const p = await requireAdmin(request);
  const snap = await db().ref(`${ROOT}/reports`).orderByChild('createdAt').limitToLast(100).get();
  const reports = [];
  snap.forEach((child) => reports.push({ ...(child.val() || {}), id: child.key }));
  reports.sort((a, b) => b.createdAt - a.createdAt);
  return { reports };
});

const messengerAdminGetReportDetail = onCall(async (request) => {
  await requireAdmin(request);
  const reportId = String((request.data || {}).reportId || '');
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(reportId)) throw new HttpsError('invalid-argument', '신고 번호가 올바르지 않습니다.');
  const [reportSnap, evidenceSnap] = await Promise.all([
    db().ref(`${ROOT}/reports/${reportId}`).get(), db().ref(`${ROOT}/reportEvidence/${reportId}`).get(),
  ]);
  if (!reportSnap.exists()) throw new HttpsError('not-found', '신고를 찾을 수 없습니다.');
  const evidence = Object.values(evidenceSnap.val() || {}).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return { report: reportSnap.val(), evidence };
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
  if (typeof uid !== 'string' || uid.length > 128 || typeof banned !== 'boolean') throw new HttpsError('invalid-argument', '계정 정지 정보가 올바르지 않습니다.');
  const path = `bannedAccounts/${uid}/games/${SERVICE_ID}`;
  if (banned) await db().ref(path).set({ reason: safeText(reason || '관리자 조치', 200), at: now(), by: p.uid });
  else await db().ref(path).remove();
  await writeAudit(p.uid, banned ? 'account.ban' : 'account.unban', uid);
  return { banned };
});

const messengerExpireRequests = onSchedule({ schedule: '0 * * * *', timeZone: 'Asia/Seoul', region: 'us-central1' }, async () => {
  const snap = await db().ref(`${ROOT}/rooms`).get();
  const rooms = snap.val() || {};
  const t = now(); const updates = {};
  for (const [roomId, room] of Object.entries(rooms)) {
    const apps = room && room.applications || {};
    for (const [uid, app] of Object.entries(apps)) {
      if (app && app.status === 'pending' && Number(app.expiresAt) <= t) updates[`${ROOT}/rooms/${roomId}/applications/${uid}/status`] = 'expired';
    }
  }
  if (Object.keys(updates).length) await db().ref().update(updates);
});

const messengerPurgeExpiredData = onSchedule({ schedule: '0 0 * * *', timeZone: 'Asia/Seoul', region: 'us-central1' }, async () => {
  const t = now(); const cutoff = t - CHAT_RETENTION;
  const roomsSnap = await db().ref(`${ROOT}/rooms`).get();
  const rooms = roomsSnap.val() || {}; const updates = {};
  for (const roomId of Object.keys(rooms)) {
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
  }
  if (Object.keys(updates).length) await db().ref().update(updates);
});

module.exports = {
  messengerGetSession, messengerGetRoomState, messengerEnsureRoom, messengerUpdateRoom, messengerDiscardRoom, messengerApplyToRoom,
  messengerListApplications, messengerListFans, messengerReviewApplication, messengerSetMemberStatus,
  messengerSendMessage, messengerGetGalleryImages, messengerGetGalleryImage, messengerSubmitReport,
  messengerAdminGetDashboard, messengerAdminGetReportDetail, messengerAdminUpdateReport, messengerAdminSetBan,
  messengerExpireRequests, messengerPurgeExpiredData,
};
