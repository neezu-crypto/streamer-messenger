const { getDatabase } = require('firebase-admin/database');
const { HttpsError } = require('firebase-functions/v2/https');

const ADMIN_EMAIL = 'skftodwocks2@gmail.com';
const SERVICE_ID = 'streamerMessenger';

function requireAuth(request) {
  if (!request.auth || !request.auth.uid) throw new HttpsError('unauthenticated', '로그인이 필요합니다.');
  return request.auth.uid;
}

function isRealAccount(request) {
  const provider = request.auth && request.auth.token && request.auth.token.firebase && request.auth.token.firebase.sign_in_provider;
  return provider !== 'anonymous';
}

async function isAdmin(uid, email) {
  const db = getDatabase();
  const snap = await db.ref(`adminCenter/adminUids/${uid}`).get();
  return snap.val() === true || email === ADMIN_EMAIL;
}

async function getVerifiedStreamer(uid) {
  const db = getDatabase();
  const snap = await db.ref('streamerVerifications').orderByChild('uid').equalTo(uid).limitToFirst(1).get();
  if (!snap.exists()) return null;
  let result = null;
  snap.forEach((child) => {
    const value = child.val() || {};
    result = { nickname: value.nickname || '', soopId: String(value.soopId || '').toLowerCase() };
  });
  return result;
}

async function assertNotBanned(uid) {
  const db = getDatabase();
  const snap = await db.ref(`bannedAccounts/${uid}`).get();
  const ban = snap.val() || {};
  if (ban.all || (ban.games && ban.games[SERVICE_ID])) {
    throw new HttpsError('permission-denied', '이 계정은 메신저 이용이 제한되어 있습니다.');
  }
}

async function getPrincipal(request, options = {}) {
  const uid = requireAuth(request);
  const email = request.auth.token && request.auth.token.email;
  const admin = await isAdmin(uid, email);
  const streamer = await getVerifiedStreamer(uid);
  const real = isRealAccount(request);
  const trusted = real || admin || !!streamer;
  if (options.requireTrusted && !trusted) {
    throw new HttpsError('permission-denied', 'Google/카카오 로그인 또는 스트리머 인증 후 이용해 주세요.');
  }
  if (options.checkBan !== false && !admin) await assertNotBanned(uid);
  return { uid, email: email || '', admin, streamer, real, trusted };
}

async function requireAdmin(request) {
  const principal = await getPrincipal(request);
  if (!principal.admin) throw new HttpsError('permission-denied', '관리자 권한이 필요합니다.');
  return principal;
}

module.exports = { SERVICE_ID, requireAuth, isRealAccount, getPrincipal, requireAdmin, getVerifiedStreamer };
