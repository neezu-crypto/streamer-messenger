import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInAnonymously, signInWithPopup,
  signInWithCustomToken, linkWithPopup, signOut, onAuthStateChanged,
  setPersistence, browserLocalPersistence,
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js';
import {
  getDatabase, ref, get, set, onValue, query, orderByKey, orderByChild,
  limitToFirst, limitToLast, startAt, endAt, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-functions.js';

// Firebase Web App 설정은 기존 streamer-gallery Web App과 공유해 UID와 로그인 계정이 동일하게 유지된다.
const firebaseConfig = {
  apiKey: 'AIzaSyAZcjQPHphENs-Bb7IfdL2qTtOMhJrRP54',
  authDomain: 'soop-stock-market.firebaseapp.com',
  databaseURL: 'https://soop-stock-market-default-rtdb.firebaseio.com',
  projectId: 'soop-stock-market',
  storageBucket: 'soop-stock-market.firebasestorage.app',
  messagingSenderId: '997788925900',
  appId: '1:997788925900:web:8fa090a599797eb6a3a769',
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// Firebase Auth persistence is scoped to the browser origin and Firebase API key/app name.
// The sibling GitHub Pages sites share neezu-crypto.github.io and the default app name,
// so keep the real account persisted there for cross-project navigation.
const persistenceReady = setPersistence(auth, browserLocalPersistence).catch((error) => {
  console.error('브라우저 로그인 유지 설정 실패:', error);
});
const db = getDatabase(app);
const functions = getFunctions(app);
const googleProvider = new GoogleAuthProvider();
const call = (name, data) => httpsCallable(functions, name)(data || {}).then((result) => result.data);

const state = { user: null, session: null, ready: false };
const sessionWaiters = [];
function notifySession() {
  document.dispatchEvent(new CustomEvent('messenger-session', { detail: { ...state } }));
  while (sessionWaiters.length) sessionWaiters.shift()(state);
}
function waitForSession() {
  if (state.ready) return Promise.resolve(state);
  return new Promise((resolve) => sessionWaiters.push(resolve));
}

async function refreshSession(user) {
  const previousSession = state.session;
  state.user = user;
  // Focus-based refreshes can fail transiently. Keep the last verified session
  // for this same Firebase UID so a server timeout never looks like sign-out.
  if (!previousSession || previousSession.uid !== user.uid) state.session = null;
  set(ref(db, `presence/streamerMessenger/${user.uid}`), { lastSeen: Date.now() }).catch((error) => console.error('접속 집계 기록 실패:', error));
  try { state.session = await call('messengerGetSession'); }
  catch (error) {
    console.error('메신저 계정 상태 확인 실패:', error);
    state.session = previousSession && previousSession.uid === user.uid ? previousSession : null;
  }
  state.ready = true;
  notifySession();
}

// Restore/migrate the persisted real account before observing auth state.
// Registering the observer first can deliver a transient null user, which the
// anonymous fallback would otherwise persist over the sibling-project login.
persistenceReady.then(() => auth.authStateReady()).then(() => onAuthStateChanged(auth, async (user) => {
  if (!user) {
    state.ready = false;
    try { await signInAnonymously(auth); }
    catch (error) { console.error('익명 세션 시작 실패:', error); state.ready = true; notifySession(); }
    return;
  }
  await refreshSession(user);
}));

function confirmDialog(message) {
  return new Promise((resolve) => {
    const dialog = document.getElementById('generic-dialog');
    document.getElementById('generic-message').textContent = message;
    const yes = document.getElementById('generic-confirm');
    const no = document.getElementById('generic-cancel');
    const close = document.getElementById('generic-close');
    const finish = (value) => { dialog.close(); yes.removeEventListener('click', onYes); no.removeEventListener('click', onNo); close.removeEventListener('click', onNo); resolve(value); };
    const onYes = () => finish(true); const onNo = () => finish(false);
    yes.addEventListener('click', onYes); no.addEventListener('click', onNo); close.addEventListener('click', onNo);
    dialog.showModal();
  });
}

async function loginGoogle() {
  if (!auth.currentUser) throw new Error('로그인 세션을 불러오는 중입니다.');
  try {
    await linkWithPopup(auth.currentUser, googleProvider);
    await call('linkGoogleAccount');
    await refreshSession(auth.currentUser);
  } catch (error) {
    if (error.code !== 'auth/credential-already-in-use') throw error;
    const ok = await confirmDialog('이미 다른 자매 서비스에서 사용 중인 Google 계정입니다. 같은 계정으로 전환할까요?');
    if (!ok) return;
    await signInWithPopup(auth, googleProvider);
    await call('linkGoogleAccount');
    await refreshSession(auth.currentUser);
  }
}

async function loginKakao() {
  if (!window.Kakao) throw new Error('카카오 로그인을 불러오지 못했습니다.');
  const kakaoKey = 'ed4f01d6903ca41d5dc0ab32b6ae143c';
  if (!window.Kakao.isInitialized()) window.Kakao.init(kakaoKey);
  const accessToken = await new Promise((resolve, reject) => window.Kakao.Auth.login({
    success: (result) => resolve(result.access_token),
    fail: reject,
  }));
  const result = await call('linkKakaoAccount', { kakaoAccessToken: accessToken });
  if (result.action === 'switch' && result.customToken) await signInWithCustomToken(auth, result.customToken);
  await refreshSession(auth.currentUser);
}

async function requestStreamerVerification(data) {
  const result = await call('requestStreamerVerification', { ...(data || {}), source: 'streamer-messenger' });
  if (result.action === 'switch' && result.customToken) await signInWithCustomToken(auth, result.customToken);
  await refreshSession(auth.currentUser);
  return result;
}

window.messenger = {
  auth, db, state, ref, get, set, onValue, query, orderByKey, orderByChild,
  limitToFirst, limitToLast, startAt, endAt, serverTimestamp,
  call, waitForSession, refreshSession, loginGoogle, loginKakao,
  requestStreamerVerification, signOut: () => signOut(auth),
};
