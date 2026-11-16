// 메신저 다마고치(2026-11-16).
// 스트리머 채팅방에 들어가면 그 스트리머의 펫이 화면을 돌아다니고, 눌러서 돌봄 창을 연다.
// - 펫 목록·돌봄은 팬페이지 다마고치 callable(streamerFanPageTamagotchiShop / Care)을 그대로 쓴다(새 서버 없음).
// - 돌봄 창은 팬페이지 돌봄 모듈(mountCareView), 펫 그림은 상점 모듈(createMongsil)을 같은 github.io에서 불러온다.
// - 돌아다니는 위치는 경과 시간 기준으로 움직이고, 탭이 숨겨지거나 동작 줄이기면 멈춘다.
// - 드래그로 옮긴 위치(화면 비율)만 이 기기 localStorage에 남긴다. 서버 저장 없음.
const FANPAGE_BASE = 'https://neezu-crypto.github.io/streamer-fanpage/';
const SHOP_BASE = 'https://neezu-crypto.github.io/streamer-game-series-shop/';
const CARE_VIEW_URL = `${FANPAGE_BASE}tamagotchi-care-view.js?v=20261116-hosp1`;
const PET_URL = `${SHOP_BASE}tamagotchi-pet.js?v=20261114-tg-wear1`;
const PUBLIC_URL = 'https://streamer-fanpage-rtdb.firebaseio.com/streamerFanPageTamagotchiPublic';
const POS_KEY = 'streamerMessenger.pet.pos.v1';
const HIDE_KEY = 'streamerMessenger.pet.hidden.v1';
const WALK_SPEED = 38; // px/초
const REST_MIN_MS = 2500; const REST_MAX_MS = 7000;
// 돌봄 종류 → 돌아다니는 펫이 보여 줄 동작
const REACT_PRESET = {
  pet: '쓰다듬 받음', groom: '털갈이', feed: '먹기', snack: '먹기', gem: '보석', play: '놀기', bath: '목욕', nap: '졸림', walk: '산책',
  talk: '대화', sing: '노래', dance: '춤', cheer: '응원', outpatient: '기쁨', discharge: '기쁨', treat: '기쁨',
};

const reduced = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
const mobile = () => !!(window.matchMedia && window.matchMedia('(max-width: 560px)').matches);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

let current = null; // { roomId, streamerId, roamer, careDialog, careApi, button }
let token = 0;

function api() { return window.messenger; }
function call(name, data) { return api().call(name, data); }

function readJson(key) { try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (_) { return {}; } }
function writeJson(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {} }
function isHidden(streamerId) { return readJson(HIDE_KEY)[streamerId] === true; }
function setHidden(streamerId, on) { const all = readJson(HIDE_KEY); if (on) all[streamerId] = true; else delete all[streamerId]; writeJson(HIDE_KEY, all); }

// ---------- 돌아다니는 펫 ----------
function createRoamer({ pet, streamerId, createMongsil, onOpen }) {
  const size = mobile() ? 76 : 104;
  const host = document.createElement('div');
  host.className = 'messenger-pet';
  host.style.width = `${size}px`; host.style.height = `${size}px`;
  host.setAttribute('role', 'button'); host.tabIndex = 0;
  host.setAttribute('aria-label', `${pet.nickname || '다마고치'} 돌보기 (끌어서 옮길 수 있어요)`);
  host.title = `${pet.nickname || '다마고치'} · 눌러서 돌보기 · 끌어서 옮기기`;
  const body = document.createElement('div'); body.className = 'messenger-pet-body';
  const name = document.createElement('span'); name.className = 'messenger-pet-name'; name.textContent = pet.nickname || '다마고치';
  host.append(body, name);
  document.body.append(host);
  const petApi = createMongsil(body, { color: pet.color || 'cream', reduced: reduced(), wear: pet.wear || null });
  if (mobile()) petApi.setLowPower?.(true);

  const bounds = () => ({ w: Math.max(0, window.innerWidth - size), h: Math.max(0, window.innerHeight - size - 8) });
  const saved = readJson(POS_KEY)[streamerId];
  let x; let y;
  { const b = bounds(); x = saved ? saved.x * b.w : b.w * 0.85; y = saved ? saved.y * b.h : b.h * 0.8; }
  let target = null; let restUntil = performance.now() + 1500; let last = performance.now();
  let frame = 0; let dragging = null; let stopped = false; let facing = 1;
  // 들어 올림·흔들림 상태(드래그 전용 연출). 모두 경과 시간 기준 스프링으로 움직인다.
  const anim = { lift: 0, liftV: 0, liftTo: 0, swing: 0, swingV: 0, vx: 0, stillSince: 0, happy: false };
  const shadow = document.createElement('div'); shadow.className = 'messenger-pet-shadow';
  const lift = document.createElement('div'); lift.className = 'messenger-pet-lift';
  body.replaceWith(lift); lift.append(body); host.prepend(shadow);

  function place() {
    host.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
    body.style.transform = facing < 0 ? 'scaleX(-1)' : '';
    const stretch = 1 + Math.min(0.08, anim.lift / 250);
    lift.style.transform = `translateY(${(-anim.lift).toFixed(1)}px) rotate(${anim.swing.toFixed(2)}deg) scale(${(2 - stretch).toFixed(3)}, ${stretch.toFixed(3)})`;
    const k = 1 - Math.min(0.55, anim.lift / 60);
    shadow.style.transform = `translateX(-50%) scale(${k.toFixed(3)})`; shadow.style.opacity = String((0.35 * k + 0.1).toFixed(3));
  }
  function walkTo(t) {
    target = t; facing = t.x >= x ? 1 : -1;
    // 걷는 동안 산책 동작을 유지한다(도착 예상 시간만큼).
    petApi.hold?.('산책', Math.hypot(t.x - x, t.y - y) / WALK_SPEED + 0.5, { quiet: true });
  }
  function pickTarget() {
    const b = bounds();
    // 너무 멀리 가지 않게 지금 자리 근처(화면의 35% 안)에서 다음 목적지를 고른다.
    const r = Math.min(b.w, b.h) * 0.35 + 60;
    walkTo({ x: clamp(x + (Math.random() * 2 - 1) * r, 0, b.w), y: clamp(y + (Math.random() * 2 - 1) * r * 0.6, 0, b.h) });
  }
  function spring(dt) {
    const calm = reduced();
    // 들어 올림: 놓으면 아래로 떨어지듯(강한 스프링·약한 감쇠)
    const ks = dragging ? 120 : 260; const kd = dragging ? 16 : 14;
    anim.liftV += ((anim.liftTo - anim.lift) * ks - anim.liftV * kd) * dt; anim.lift += anim.liftV * dt;
    if (!dragging && anim.lift < 0) { anim.lift = 0; if (anim.liftV < -60) land(); anim.liftV = 0; }
    // 흔들림: 끄는 방향 반대로 매달려 흔들리는 진자
    const swingTo = calm || !dragging ? 0 : clamp(-anim.vx * 0.045, -28, 28);
    anim.swingV += ((swingTo - anim.swing) * 70 - anim.swingV * (dragging ? 7 : 9)) * dt; anim.swing += anim.swingV * dt;
    if (calm) { anim.swing = 0; anim.swingV = 0; }
    anim.vx *= Math.exp(-dt * 8);
  }
  function land() {
    if (reduced()) return;
    lift.classList.remove('is-landing'); void lift.offsetWidth; lift.classList.add('is-landing');
    petApi.fx?.('spark');
  }
  function tick(now) {
    frame = 0;
    if (stopped) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (!dragging && !reduced()) {
      if (target) {
        const dx = target.x - x; const dy = target.y - y; const dist = Math.hypot(dx, dy);
        const step = WALK_SPEED * dt;
        if (dist <= step) { x = target.x; y = target.y; target = null; restUntil = now + REST_MIN_MS + Math.random() * (REST_MAX_MS - REST_MIN_MS); }
        else { x += (dx / dist) * step; y += (dy / dist) * step; }
      } else if (now >= restUntil) pickTarget();
    }
    if (dragging && dragging.moved && !anim.happy && now - anim.stillSince > 1200) {
      // 들고 가만히 있으면 놀람 → 즐거워하기
      anim.happy = true; petApi.hold?.('기쁨', 60, { quiet: true });
    }
    spring(dt);
    place();
    schedule();
  }
  // 모바일은 30fps 상한(경과 시간 기준이라 속도는 같다).
  let lastFrameAt = 0;
  function schedule() {
    if (stopped || frame || document.hidden) return;
    frame = requestAnimationFrame((t) => {
      if (mobile() && t - lastFrameAt < 33) { frame = 0; schedule(); return; }
      lastFrameAt = t; tick(t);
    });
  }
  function onVisibility() {
    petApi.setPaused?.(document.hidden);
    if (!document.hidden) { last = performance.now(); schedule(); }
  }
  function savePos() {
    const b = bounds(); const all = readJson(POS_KEY);
    all[streamerId] = { x: b.w ? +(x / b.w).toFixed(4) : 0.85, y: b.h ? +(y / b.h).toFixed(4) : 0.8 };
    writeJson(POS_KEY, all);
  }
  function onResize() { const b = bounds(); x = clamp(x, 0, b.w); y = clamp(y, 0, b.h); target = null; place(); }

  // 누르기: 쓰다듬 반응(하트·깡총) 뒤 돌봄 창을 연다
  function tap(clientX, clientY) {
    petApi.play?.('쓰다듬 받음', { hop: true, seconds: 1.6 });
    if (clientX != null) petApi.heartAt?.(clientX, clientY);
    target = null; restUntil = performance.now() + REST_MAX_MS;
    setTimeout(() => { if (!stopped) onOpen(); }, reduced() ? 0 : 380);
  }

  // 드래그: 4px 넘게 움직이면 들어서 옮기기, 아니면 누르기
  host.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: x, oy: y, moved: false, lx: e.clientX, lt: performance.now() };
    host.setPointerCapture(e.pointerId);
    target = null;
  });
  host.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== dragging.id) return;
    const dx = e.clientX - dragging.sx; const dy = e.clientY - dragging.sy;
    if (!dragging.moved && Math.hypot(dx, dy) < 4) return;
    const now = performance.now();
    if (!dragging.moved) {
      // 집어 올리는 순간: 깜짝 놀라며 위로 들림
      dragging.moved = true; host.classList.add('is-dragging');
      anim.liftTo = 16; anim.happy = false; anim.stillSince = now;
      petApi.hold?.('놀람', 60, { quiet: true });
    }
    const ddt = Math.max(0.008, (now - dragging.lt) / 1000);
    const v = (e.clientX - dragging.lx) / ddt; anim.vx = anim.vx * 0.6 + v * 0.4;
    if (Math.abs(v) > 120) { anim.stillSince = now; if (anim.happy) { anim.happy = false; petApi.hold?.('놀람', 60, { quiet: true }); } }
    dragging.lx = e.clientX; dragging.lt = now;
    const b = bounds();
    x = clamp(dragging.ox + dx, 0, b.w); y = clamp(dragging.oy + dy, 0, b.h);
    if (Math.abs(v) > 30) facing = v > 0 ? 1 : -1;
    schedule();
  });
  const endDrag = (e) => {
    if (!dragging || e.pointerId !== dragging.id) return;
    const moved = dragging.moved; dragging = null;
    host.classList.remove('is-dragging');
    anim.liftTo = 0;
    if (moved) { savePos(); restUntil = performance.now() + REST_MAX_MS; petApi.play?.('놀기', { hop: true, seconds: 1.6 }); if (reduced()) anim.lift = 0; }
    else tap(e.clientX, e.clientY);
    schedule();
  };
  host.addEventListener('pointerup', endDrag);
  host.addEventListener('pointercancel', (e) => {
    if (!dragging || e.pointerId !== dragging.id) return;
    dragging = null; host.classList.remove('is-dragging'); anim.liftTo = 0; petApi.play?.('기본', { seconds: 0.5 }); schedule();
  });
  // 마우스를 올리면 그쪽을 살짝 바라본다(터치 기기 제외)
  host.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse' && !dragging && !target) petApi.chase?.(e.clientX, e.clientY, 18); });
  host.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !dragging) petApi.chase?.(); });
  // 키보드: Enter/Space로 돌봄 창, 방향키로 옮기기
  host.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tap(); return; }
    const d = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] }[e.key];
    if (!d) return;
    e.preventDefault(); const b = bounds(); x = clamp(x + d[0], 0, b.w); y = clamp(y + d[1], 0, b.h); if (d[0]) facing = d[0] > 0 ? 1 : -1; target = null; place(); savePos();
  });

  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('resize', onResize);
  place(); schedule();

  // 돌봄 창에서 한 행동을 돌아다니는 펫도 따라 한다(창을 닫으면 마지막 행동을 보여 준다)
  let pendingReact = '';
  function react(kind) {
    const preset = REACT_PRESET[kind]; if (!preset) return;
    pendingReact = preset;
  }
  function flushReact() {
    if (!pendingReact) return;
    const p = pendingReact; pendingReact = '';
    target = null; restUntil = performance.now() + REST_MAX_MS;
    petApi.play?.(p, { hop: !reduced(), seconds: 2.4 });
  }

  return {
    host, petApi, react, flushReact,
    setCondition(c) { if (c) petApi.setCondition?.(c); },
    setWear(w) { petApi.setWear?.(w || {}); },
    destroy() {
      stopped = true; if (frame) cancelAnimationFrame(frame);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', onResize);
      petApi.destroy?.(); host.remove();
    },
  };
}

// ---------- 돌봄 창 ----------
function ensureCareDialog() {
  let dialog = document.getElementById('messenger-pet-dialog');
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.id = 'messenger-pet-dialog';
  dialog.className = 'app-dialog messenger-pet-dialog';
  dialog.setAttribute('aria-labelledby', 'messenger-pet-title');
  const card = document.createElement('section'); card.className = 'dialog-card messenger-pet-care';
  const close = document.createElement('button'); close.type = 'button'; close.className = 'dialog-close'; close.textContent = '×'; close.setAttribute('aria-label', '돌봄 창 닫기');
  close.addEventListener('click', () => dialog.close());
  dialog.addEventListener('close', () => { current?.roamer?.flushReact(); });
  const title = document.createElement('h2'); title.id = 'messenger-pet-title';
  const host = document.createElement('div'); host.className = 'messenger-pet-care-host';
  const foot = document.createElement('div'); foot.className = 'messenger-pet-care-foot';
  card.append(close, title, host, foot);
  dialog.append(card);
  document.body.append(dialog);
  return dialog;
}

async function openCare() {
  const c = current; if (!c) return;
  const dialog = ensureCareDialog();
  dialog.querySelector('#messenger-pet-title').textContent = c.pet ? `${c.pet.nickname || '다마고치'} 돌보기` : '다마고치';
  const foot = dialog.querySelector('.messenger-pet-care-foot');
  foot.replaceChildren();
  const fanpage = document.createElement('a');
  fanpage.href = `${FANPAGE_BASE}?id=${encodeURIComponent(c.streamerId)}`; fanpage.target = '_blank'; fanpage.rel = 'noopener';
  fanpage.className = 'text-button'; fanpage.textContent = '팬페이지에서 보기 ↗';
  const hide = document.createElement('button'); hide.type = 'button'; hide.className = 'text-button';
  hide.textContent = '이 채팅방에서 펫 숨기기';
  hide.addEventListener('click', () => { setHidden(c.streamerId, true); c.roamer?.destroy(); c.roamer = null; renderToggle(); dialog.close(); });
  foot.append(fanpage); if (c.pet) foot.append(hide);
  if (!dialog.open) dialog.showModal();
  if (c.careApi) { c.careApi.reload?.(); return; }
  const host = dialog.querySelector('.messenger-pet-care-host');
  try {
    const { mountCareView } = await import(CARE_VIEW_URL);
    if (current !== c) return;
    const s = api().state.session || {};
    c.careApi = mountCareView(host, {
      page: { streamer: { id: c.streamerId, nickname: c.room.streamerNickname || '' }, isStreamerOwner: c.isOwner },
      callShop: (data) => call('streamerFanPageTamagotchiShop', data).then((d) => ({ data: d })),
      callCare: (data) => call('streamerFanPageTamagotchiCare', data).then((d) => {
        // 돌봄 결과(상태·꾸미기)를 돌아다니는 펫에도 바로 반영한다.
        if (d && current === c && c.roamer) {
          const kinds = data.action === 'interact' ? (Array.isArray(data.batch) ? data.batch.map((b) => b && b.kind) : []) : [data.action === 'treat' ? 'treat' : data.action];
          for (const k of kinds) c.roamer.react(k);
        }
        if (d && current === c && c.roamer) { if (d.condition) c.roamer.setCondition(d.condition); if (d.shop && d.shop.equipped) c.roamer.setWear(d.shop.equipped); }
        return { data: d };
      }),
      isAdmin: s.isAdmin === true,
      canManage: c.isOwner || s.isAdmin === true,
      hasAccount: () => { const ss = api().state.session || {}; return !!(ss.trusted || ss.isVerifiedStreamer); },
      openLogin: () => { dialog.close(); document.getElementById('auth-dialog')?.showModal?.(); },
      openApplication: null,
      callOverlay: null,
    });
  } catch (error) {
    host.textContent = error && error.message ? error.message : '돌봄 화면을 불러오지 못했어요.';
  }
}

function renderToggle() {
  const c = current; const btn = document.getElementById('toggle-room-pet');
  if (!btn) return;
  btn.hidden = !c;
  if (!c) return;
  if (!c.pet) { btn.removeAttribute('aria-pressed'); btn.title = '다마고치 분양 안내'; return; }
  const hidden = !c.roamer;
  btn.setAttribute('aria-pressed', String(!hidden));
  btn.title = hidden ? '펫 다시 보이기' : `${c.pet.nickname || '다마고치'} 돌보기`;
}

function ensureToggleButton() {
  let btn = document.getElementById('toggle-room-pet');
  if (btn) return btn;
  const actions = document.querySelector('.chat-header-actions');
  if (!actions) return null;
  btn = document.createElement('button');
  btn.type = 'button'; btn.id = 'toggle-room-pet'; btn.className = 'button button-quiet messenger-pet-toggle'; btn.hidden = true;
  btn.innerHTML = '<span aria-hidden="true">🐾</span><span class="mini-game-trigger-label"> 펫</span>';
  btn.setAttribute('aria-label', '다마고치 돌보기');
  btn.addEventListener('click', () => {
    const c = current; if (!c) return;
    if (c.pet && !c.roamer) { setHidden(c.streamerId, false); void showRoamer(c); renderToggle(); return; }
    void openCare();
  });
  actions.prepend(btn);
  return btn;
}

async function showRoamer(c) {
  if (c.roamer || current !== c) return;
  const { createMongsil } = await import(PET_URL);
  if (current !== c || c.roamer) return;
  c.roamer = createRoamer({ pet: c.pet, streamerId: c.streamerId, createMongsil, onOpen: () => void openCare() });
  if (c.condition) c.roamer.setCondition(c.condition);
  renderToggle();
}

function teardown() {
  token += 1;
  const c = current; current = null;
  if (!c) { renderToggle(); return; }
  c.roamer?.destroy();
  c.careApi?.destroy?.();
  const dialog = document.getElementById('messenger-pet-dialog');
  if (dialog) { if (dialog.open) dialog.close(); dialog.querySelector('.messenger-pet-care-host')?.replaceChildren(); }
  renderToggle();
}

// 공개 요약(서버 호출 없음): 팬페이지 DB의 단일 공개 경로를 REST로 1번 읽는다. 없으면 null.
// 같은 탭에서 10분 동안은 다시 읽지 않는다("펫 없음"도 기억). 자동 갱신은 하지 않는다(설계 결정).
const PUBLIC_CACHE_KEY = 'streamerMessenger.pet.public.v1';
const PUBLIC_CACHE_MS = 10 * 60 * 1000;
function cachedPublic(streamerId) {
  try {
    const all = JSON.parse(sessionStorage.getItem(PUBLIC_CACHE_KEY) || '{}') || {};
    const hit = all[streamerId];
    return hit && Date.now() - hit.t < PUBLIC_CACHE_MS ? hit.v : undefined;
  } catch (_) { return undefined; }
}
function storePublic(streamerId, value) {
  try {
    const all = JSON.parse(sessionStorage.getItem(PUBLIC_CACHE_KEY) || '{}') || {};
    const now = Date.now();
    for (const k of Object.keys(all)) if (!all[k] || now - all[k].t >= PUBLIC_CACHE_MS) delete all[k];
    all[streamerId] = { t: now, v: value };
    sessionStorage.setItem(PUBLIC_CACHE_KEY, JSON.stringify(all));
  } catch (_) {}
}
async function readPublic(streamerId) {
  const hit = cachedPublic(streamerId);
  if (hit !== undefined) return hit;
  const res = await fetch(`${PUBLIC_URL}/${encodeURIComponent(streamerId)}.json`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`public ${res.status}`);
  const value = await res.json();
  if (value && value.at) storePublic(streamerId, value); // 아직 없는 요약(null)은 기억하지 않는다
  return value;
}
function petsFromPublic(pub) {
  return Object.entries(pub && pub.pets && typeof pub.pets === 'object' ? pub.pets : {})
    .map(([petId, p]) => ({ petId, ...p }))
    .sort((x, y) => (Number(x.adoptedAt) || 0) - (Number(y.adoptedAt) || 0) || x.petId.localeCompare(y.petId));
}

async function onRoomOpened(room, isOwner) {
  teardown();
  const streamerId = String(room && room.streamerSoopId || '').trim().toLowerCase();
  if (!streamerId || (room.roomType && room.roomType !== 'streamer')) return;
  const my = token;
  ensureToggleButton();
  let pets = null;
  try { const pub = await readPublic(streamerId); if (pub && pub.at) pets = petsFromPublic(pub); } catch (_) { /* 아래 서버 조회로 */ }
  if (pets === null) {
    // 아직 공개 요약이 없는 스트리머(처음 한 번): 기존 조회를 부르면 서버가 공개 요약을 만들어 둔다.
    try { pets = ((await call('streamerFanPageTamagotchiShop', { action: 'pets', streamerId })) || {}).pets || []; }
    catch (_) { return; }
  }
  if (my !== token) return;
  if (!pets.length) {
    // 펫이 없으면 팬에게는 아무것도 보이지 않고, 스트리머 본인에게만 분양 안내 버튼을 둔다.
    if (isOwner) { current = { room, isOwner: true, streamerId, pet: null, roamer: null, careApi: null, condition: '' }; renderToggle(); }
    return;
  }
  const pet = pets[0];
  current = { room, isOwner: !!isOwner, streamerId, pet, roamer: null, careApi: null, condition: pet.condition || '' };
  renderToggle();
  if (!isHidden(streamerId)) await showRoamer(current);
}

export function initMessengerPet() {
  document.addEventListener('messenger:room-opened', (e) => { void onRoomOpened(e.detail && e.detail.room, e.detail && e.detail.isOwner); });
  document.addEventListener('messenger:room-closed', teardown);
  window.addEventListener('pagehide', teardown);
}
