import { getApps, initializeApp } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithPopup, GoogleAuthProvider } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-functions.js';

const firebaseConfig = {
  apiKey: 'AIzaSyAZcjQPHphENs-Bb7IfdL2qTtOMhJrRP54',
  authDomain: 'soop-stock-market.firebaseapp.com',
  databaseURL: 'https://soop-stock-market-default-rtdb.firebaseio.com',
  projectId: 'soop-stock-market',
  storageBucket: 'soop-stock-market.firebasestorage.app',
  messagingSenderId: '997788925900',
  appId: '1:997788925900:web:b58db2970489bf18a3a769'
};

// 서비스 일시정지 플래그: 통합 관리 센터의 "서비스 일시정지" 세션이 쓰는 {active, updatedAt}.
// active가 true면 안내 화면을 보이고, false면 모두에게 연다. 값이 없거나 읽지 못하면 이 서비스의 기본 상태를 따른다.
// SERVICE_ID / PAUSE_FLAG_URL / DEFAULT_PAUSED 는 서비스마다 다르다(나머지 코드는 시리즈 공통).
const SERVICE_ID = 'streamerMessenger';
const PAUSE_FLAG_URL = 'https://soop-stock-market-default-rtdb.firebaseio.com/servicePause/streamerMessenger.json';
const DEFAULT_PAUSED = true;
const PAUSE_POLL_MS = 20 * 1000;
const PAUSE_FETCH_TIMEOUT_MS = 5000;
const PAGE_APP_WAIT_MS = 4000;

let unlocked = false;
let adminUnlocked = false;
let pauseKnown = false;
let paused = DEFAULT_PAUSED;
let locked = false;
let gate;
let auth;
let checkAccess;

function render(message, canLogin = true) {
  if (!gate) return;
  gate.querySelector('[data-maintenance-status]').textContent = message;
  gate.querySelector('[data-maintenance-login]').disabled = !canLogin;
}

function blockInteraction(event) {
  if (!locked || gate?.contains(event.target)) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}

function lockPage() {
  if (locked) return;
  locked = true;
  unlocked = false;
  document.addEventListener('click', blockInteraction, true);
  document.addEventListener('pointerdown', blockInteraction, true);
  document.addEventListener('keydown', blockInteraction, true);
  document.addEventListener('submit', blockInteraction, true);
}

function unlockPage() {
  locked = false;
  unlocked = true;
  document.removeEventListener('click', blockInteraction, true);
  document.removeEventListener('pointerdown', blockInteraction, true);
  document.removeEventListener('keydown', blockInteraction, true);
  document.removeEventListener('submit', blockInteraction, true);
  if (gate) gate.style.display = 'none';
  document.documentElement.removeAttribute('data-series-maintenance');
}

// 일시정지 상태와 관리자 확인 결과로 안내 화면을 보이거나 숨긴다.
// 상태를 아직 모르는 동안에는 기본 상태가 일시정지인 서비스만 입력을 막고, 화면은 확인 뒤에 보인다.
function applyState() {
  if (adminUnlocked || !paused) {
    unlockPage();
    return;
  }
  lockPage();
  if (gate) gate.style.display = pauseKnown ? 'grid' : 'none';
}

async function readPauseFlag() {
  try {
    const response = await fetch(`${PAUSE_FLAG_URL}?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(PAUSE_FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const value = await response.json();
    paused = value && typeof value.active === 'boolean' ? value.active : DEFAULT_PAUSED;
    pauseKnown = true;
  } catch (error) {
    console.error(`서비스 일시정지 상태 확인 실패(${SERVICE_ID}):`, error);
    // 아직 한 번도 확인하지 못했다면 기본 상태를 따르고, 이미 알던 상태는 그대로 둔다.
    if (!pauseKnown) { paused = DEFAULT_PAUSED; pauseKnown = true; }
  }
  applyState();
}

function createGate() {
  const style = document.createElement('style');
  style.textContent = `
    #series-maintenance-gate{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:24px;background:#101522;color:#f4f6ff;font:16px/1.7 system-ui,sans-serif}
    #series-maintenance-gate .series-maintenance-card{width:min(100%,560px);padding:40px 28px;border:1px solid #38435a;border-radius:20px;background:#1a2232;text-align:center;box-shadow:0 22px 60px #0008}
    #series-maintenance-gate h1{margin:8px 0 16px;font-size:clamp(24px,5vw,32px);line-height:1.3}
    #series-maintenance-gate p{margin:8px 0;color:#d3dbea}
    #series-maintenance-gate button{margin-top:18px;border:0;border-radius:10px;padding:12px 18px;background:#4285f4;color:white;font:inherit;font-weight:700;cursor:pointer}
    #series-maintenance-gate button:disabled{opacity:.6;cursor:wait}
    #series-maintenance-gate a{display:block;margin-top:16px;color:#a8caff}
    #series-maintenance-gate .series-maintenance-links{margin:22px 0 0;padding:16px;border:1px solid #38435a;border-radius:14px;background:#141b29}
    #series-maintenance-gate .series-maintenance-links strong{display:block;margin-bottom:6px;color:#f4f6ff;font-size:14px}
    #series-maintenance-gate .series-maintenance-links a{margin-top:6px;font-weight:700}
  `;
  document.head.append(style);
  gate = document.createElement('section');
  gate.id = 'series-maintenance-gate';
  gate.style.display = 'none';
  gate.setAttribute('role', 'dialog');
  gate.setAttribute('aria-modal', 'true');
  gate.innerHTML = `<div class="series-maintenance-card"><div aria-hidden="true" style="font-size:40px">🛠️</div><h1>더 나은 서비스를 위해 수정 중이에요</h1><p data-maintenance-status>더 원활한 서비스를 위해 지금 수정 작업을 하고 있어요. 이용에 불편을 드려 죄송합니다. 작업이 끝나면 다시 열어 드릴게요.</p><div class="series-maintenance-links"><strong>지금 이용할 수 있는 서비스</strong><a href="https://neezu-crypto.github.io/streamer-fanpage/" rel="noopener">스트리머 팬페이지</a><a href="https://neezu-crypto.github.io/streamer-fanpage/viewer-stats.html" rel="noopener">스트리머 고점체크</a></div><button type="button" data-maintenance-login>관리자 Google 로그인</button><a href="https://www.sooplive.com/station/skftodwocks2" rel="noopener">개발자 방송국에서 공지 확인하기</a></div>`;
  document.documentElement.append(gate);
  gate.querySelector('[data-maintenance-login]').addEventListener('click', async () => {
    if (!auth) {
      render('페이지를 준비하고 있습니다. 잠시 후 다시 시도해 주세요.', false);
      return;
    }
    render('Google 계정 로그인을 기다리고 있습니다.', false);
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error('관리자 로그인 실패:', error);
      render('로그인하지 못했습니다. 관리자 Google 계정으로 다시 시도해 주세요.');
    }
  });
}

async function verify(user) {
  if (!user || user.isAnonymous) {
    adminUnlocked = false;
    applyState();
    render('더 원활한 서비스를 위해 지금 수정 작업을 하고 있어요. 이용에 불편을 드려 죄송합니다. 작업이 끝나면 다시 열어 드릴게요.');
    return;
  }
  render('관리자 권한을 확인하고 있습니다.', false);
  try {
    const result = await checkAccess({});
    if (result.data?.isAdmin === true) {
      adminUnlocked = true;
      applyState();
      return;
    }
    adminUnlocked = false;
    applyState();
    render('이 계정은 관리자 계정이 아닙니다. 관리자 계정으로 로그인해 주세요.');
  } catch (error) {
    console.error('관리자 권한 확인 실패:', error);
    render('관리자 권한을 확인하지 못했습니다. 연결을 확인한 뒤 다시 로그인해 주세요.');
  }
}

// 페이지가 만든 기본 Firebase 앱을 기다려 같은 로그인 상태를 쓴다.
// 일정 시간 안에 만들어지지 않으면 같은 설정으로 직접 만든다.
function connectToPageFirebase(startedAt = Date.now()) {
  let app = getApps().find((item) => item.name === '[DEFAULT]');
  if (!app && Date.now() - startedAt >= PAGE_APP_WAIT_MS) app = initializeApp(firebaseConfig);
  if (!app) {
    window.setTimeout(() => connectToPageFirebase(startedAt), 50);
    return;
  }
  auth = getAuth(app);
  checkAccess = httpsCallable(getFunctions(app, 'us-central1'), 'streamerFanPageMaintenanceAccess');
  onAuthStateChanged(auth, (user) => { void verify(user); });
}

createGate();
if (DEFAULT_PAUSED) lockPage();
render('페이지를 준비하고 있습니다.', false);
void readPauseFlag();
setInterval(() => { void readPauseFlag(); }, PAUSE_POLL_MS);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void readPauseFlag(); });
connectToPageFirebase();
