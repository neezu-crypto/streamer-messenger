import './firebase-init.js';

const api = () => window.messenger;
const $ = (selector) => document.querySelector(selector);
const MESSAGE_PAGE_SIZE = 100;
const state = { session: null, rooms: [], myRooms: [], myRoomsUid: '', myRoomsLoaded: false, myRoomsPromise: null, room: null, pendingStreamerRoom: null, streamerLinkHandled: false, autoRoomEnsureUid: '', autoRoomEnsurePromise: null, isOwner: false, selectedFanUid: '', fanSearchQuery: '', fans: [], blockedFans: [], applications: [], knownApplicationUids: new Set(), applicationStatusUnsubscribers: [], ownerApplicationsUnsubscribe: null, ownerApplicationsRoomId: '', messages: [], olderMessages: [], olderPrivateMessages: [], olderBroadcastMessages: [], liveMessages: [], hasOlderMessages: false, hasOlderPrivateMessages: false, hasOlderBroadcastMessages: false, olderMessagesExhausted: false, olderPrivateMessagesExhausted: false, olderBroadcastMessagesExhausted: false, loadingOlderMessages: false, optimisticMessages: [], unsubscribers: [], messageSending: false, galleryImages: new Map(), galleryStreamerId: '', galleryTargetUid: '', imageUrls: new Map(), roomselfUrls: new Map(), linkPreviewCache: new Map(), roomselfTargetUid: '', roomMarketStocks: {}, roomMarketFeed: [], roomMarketQuotes: {}, roomMarketPriceHistory: {}, roomMarketSparklineSeeded: new Set(), roomMarketQuoteUnsubscribers: new Map(), roomMarketStockCatalog: [], roomMarketSelectedStockId: '', roomMarketTrading: false, pinnedMessagePointer: null, pinnedMessageDetails: null, pinnedMessageLoading: false, pinnedMessageLoadToken: 0, pinActionPending: false, miniGame: null, miniGameSelectedLane: -1, miniGameSelectedId: '', miniGameMutationPending: false, miniGameCollapsed: false, activeRoomTool: 'market', roomToolTabKeys: '', renderedMiniGameId: '', currentReply: null, activeView: 'directory', seenMessageIds: new Set(), regenerateRoomPassword: false };
const adminState = { reportStatus: 'pending', reportCursor: null, reportHasMore: false, reports: [], reportsLoading: false, banCursor: null, banHasMore: false, bans: [], bansLoaded: false, bansLoading: false, currentReport: null };
const dialogs = ['auth-dialog', 'profile-dialog', 'application-dialog', 'room-settings-dialog', 'image-picker-dialog', 'roomself-dialog', 'verification-dialog', 'generic-dialog', 'my-rooms-dialog'];
const call = (...args) => api().call(...args);
const escapeText = (v) => String(v == null ? '' : v);
const TOOLTIP_SELECTOR = 'button, a, input:not([type="hidden"]), select, textarea, [role="button"], [role="tab"], [role="menuitem"], summary, [tabindex]:not([tabindex="-1"])';
let toastTimer = 0;

function tooltipText(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }

function inferTooltip(element) {
  const ariaLabel = tooltipText(element.getAttribute('aria-label'));
  if (ariaLabel) return ariaLabel;
  if (element.labels && element.labels.length) {
    const label = tooltipText(Array.from(element.labels, (item) => item.innerText || item.textContent).join(' '));
    if (label) return label;
  }
  const ownText = tooltipText(element.innerText || element.textContent);
  if (ownText) return ownText;
  const value = tooltipText(element.value);
  if (value) return value;
  const placeholder = tooltipText(element.getAttribute('placeholder'));
  if (placeholder) return placeholder;
  const selectedOption = element instanceof HTMLSelectElement ? tooltipText(element.selectedOptions[0]?.textContent) : '';
  if (selectedOption) return selectedOption;
  const id = tooltipText(element.id).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[-_]+/g, ' ');
  return id ? id.charAt(0).toLocaleUpperCase('ko-KR') + id.slice(1) : '';
}

function ensureTooltip(element) {
  const title = tooltipText(element.getAttribute('title'));
  const existing = tooltipText(element.dataset.tooltip);
  const generated = element.dataset.autoTooltip === 'true';
  const label = title || (existing && !generated ? existing : inferTooltip(element));
  if (!label) return;
  if (element.dataset.tooltip !== label) element.dataset.tooltip = label;
  if (!title && !existing || generated && !title) element.dataset.autoTooltip = 'true';
  else delete element.dataset.autoTooltip;
  if (element.hasAttribute('title')) element.removeAttribute('title');
}

function ensureTooltipsIn(root) {
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return;
  if (root.nodeType === Node.ELEMENT_NODE && root.matches(TOOLTIP_SELECTOR)) ensureTooltip(root);
  root.querySelectorAll(TOOLTIP_SELECTOR).forEach(ensureTooltip);
}

function applyChatTooltips(room) {
  const roomName = room.roomType === 'admin' ? '관리자 채팅방' : `${room.streamerNickname || '스트리머'} 채팅방`;
  const labels = {
    '#back-to-directory': '채팅방 목록으로 돌아가기',
    '#export-chat-button': `${roomName} 대화 저장하기`,
    '#room-menu-button': `${roomName} 대화 신고하기`,
    '#room-settings-button': `${roomName} 설정 열기`,
    '#add-room-stock': '스트리머 주식시장에서 종목을 골라 채팅방 거래 시작하기',
    '#open-mini-game': '채팅방에서 사다리타기 미니게임을 열고 함께 참여하기',
    '#fan-search': '팬 닉네임 또는 SOOP 아이디로 대화 검색하기',
    '#message-audience': '메시지를 방 전체에 보낼지 팬 한 명에게 보낼지 선택하기',
    '#direct-recipient': '메시지를 받을 팬 선택하기',
    '#open-image-picker': '스트리머 갤러리에서 이미지를 골라 채팅방에 보내기',
    '#message-input': '채팅 메시지 입력하기',
    '#send-message': '입력한 메시지 보내기',
    '#cancel-reply': '답장 작성 취소하기',
  };
  for (const [selector, label] of Object.entries(labels)) {
    const element = $(selector);
    if (element) element.title = label;
  }
  ensureTooltipsIn($('#chat-view'));
}

ensureTooltipsIn(document);
new MutationObserver((records) => {
  records.forEach((record) => {
    if (record.type === 'characterData') ensureTooltipsIn(record.target.parentElement);
    else if (record.type === 'childList') record.addedNodes.forEach(ensureTooltipsIn);
    else if (record.type === 'attributes') ensureTooltipsIn(record.target);
  });
}).observe(document.body, { childList: true, characterData: true, attributes: true, attributeFilter: ['title'], subtree: true });

const tooltipNode = document.createElement('div');
tooltipNode.id = 'app-tooltip';
tooltipNode.className = 'app-tooltip';
tooltipNode.setAttribute('role', 'tooltip');
tooltipNode.hidden = true;
document.body.appendChild(tooltipNode);
let activeTooltipTarget = null;
let tooltipTimer = 0;

function tooltipTargetFrom(target) {
  return target instanceof Element ? target.closest(TOOLTIP_SELECTOR) : null;
}

function hideTooltip() {
  window.clearTimeout(tooltipTimer);
  tooltipTimer = 0;
  if (activeTooltipTarget) {
    const ids = (activeTooltipTarget.getAttribute('aria-describedby') || '').split(/\s+/).filter((id) => id && id !== tooltipNode.id);
    if (ids.length) activeTooltipTarget.setAttribute('aria-describedby', ids.join(' '));
    else activeTooltipTarget.removeAttribute('aria-describedby');
  }
  activeTooltipTarget = null;
  tooltipNode.hidden = true;
  if (tooltipNode.parentElement !== document.body) document.body.appendChild(tooltipNode);
}

function showTooltip(target) {
  if (!target || !target.isConnected) return;
  ensureTooltip(target);
  const text = tooltipText(target.dataset.tooltip);
  if (!text) return;
  const containingDialog = target.closest('dialog[open]');
  const topDialog = Array.from(document.querySelectorAll('dialog[open]')).at(-1);
  const portal = containingDialog || topDialog || document.body;
  if (tooltipNode.parentElement !== portal) portal.appendChild(tooltipNode);
  activeTooltipTarget = target;
  tooltipNode.textContent = text;
  const describedBy = new Set((target.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean));
  describedBy.add(tooltipNode.id);
  target.setAttribute('aria-describedby', Array.from(describedBy).join(' '));
  tooltipNode.hidden = false;
  requestAnimationFrame(() => {
    if (activeTooltipTarget !== target || tooltipNode.hidden) return;
    const targetRect = target.getBoundingClientRect();
    const tooltipRect = tooltipNode.getBoundingClientRect();
    const margin = 8;
    const left = Math.min(Math.max(margin, targetRect.left + (targetRect.width - tooltipRect.width) / 2), window.innerWidth - tooltipRect.width - margin);
    const above = targetRect.top - tooltipRect.height - 9;
    const top = above >= margin ? above : Math.min(targetRect.bottom + 9, window.innerHeight - tooltipRect.height - margin);
    tooltipNode.style.left = `${left}px`;
    tooltipNode.style.top = `${Math.max(margin, top)}px`;
  });
}

function scheduleTooltip(target, delay = 280) {
  window.clearTimeout(tooltipTimer);
  tooltipTimer = window.setTimeout(() => showTooltip(target), delay);
}

document.addEventListener('pointerover', (event) => {
  const target = tooltipTargetFrom(event.target);
  if (!target || target === activeTooltipTarget) return;
  hideTooltip();
  scheduleTooltip(target);
}, true);
document.addEventListener('pointerout', (event) => {
  const target = tooltipTargetFrom(event.target);
  const nextTarget = tooltipTargetFrom(event.relatedTarget);
  if (target === activeTooltipTarget && nextTarget !== target) hideTooltip();
}, true);
document.addEventListener('pointerdown', hideTooltip, true);
document.addEventListener('focusin', (event) => {
  const target = tooltipTargetFrom(event.target);
  if (!target || target === activeTooltipTarget || !target.matches(':focus-visible')) return;
  hideTooltip();
  scheduleTooltip(target, 180);
}, true);
document.addEventListener('focusout', (event) => {
  const target = tooltipTargetFrom(event.target);
  const nextTarget = tooltipTargetFrom(event.relatedTarget);
  if (target === activeTooltipTarget && nextTarget !== target) hideTooltip();
}, true);
window.addEventListener('scroll', hideTooltip, true);
window.addEventListener('resize', hideTooltip);

async function registerGalleryImageWithRetry(payload, onRetry) {
  const deadline = Date.now() + 180000;
  const retryableCodes = new Set(['unavailable', 'deadline-exceeded', 'internal', 'unknown', 'resource-exhausted', 'aborted']);
  let lastError;
  for (let attempt = 1; attempt <= 3 && Date.now() < deadline; attempt += 1) {
    const remaining = deadline - Date.now();
    let timeoutId;
    try {
      return await Promise.race([
        call('registerImage', payload),
        new Promise((_, reject) => { timeoutId = setTimeout(() => { const error = new Error('갤러리 등록 응답을 기다리는 시간이 초과되었습니다.'); error.code = 'functions/deadline-exceeded'; reject(error); }, Math.min(60000, remaining)); }),
      ]);
    } catch (error) {
      lastError = error;
      const code = String(error && error.code || '').replace(/^functions\//, '');
      if (attempt >= 3 || !retryableCodes.has(code) || Date.now() >= deadline) throw error;
      onRetry(attempt + 1);
      await new Promise((resolve) => setTimeout(resolve, Math.min(attempt * 1500, Math.max(0, deadline - Date.now()))));
    } finally {
      clearTimeout(timeoutId);
    }
  }
  throw lastError || new Error('갤러리에 사진을 등록하지 못했습니다.');
}

function showToast(message) {
  const toast = $('#app-toast');
  if (!toast) return;
  toast.textContent = message;
  toast.hidden = false;
  toast.classList.remove('visible');
  requestAnimationFrame(() => toast.classList.add('visible'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.classList.remove('visible');
    setTimeout(() => { toast.hidden = true; }, 220);
  }, 2600);
}

function showError(error, fallback = '요청을 처리하지 못했습니다.') {
  const message = error && error.message ? error.message.replace(/^Firebase: /, '') : fallback;
  window.alert(message || fallback);
}

function avatarUrl(soopId) {
  const id = String(soopId || '').trim().toLowerCase();
  if (!/^[a-z0-9]{2,30}$/.test(id)) return '';
  return `https://stimg.sooplive.com/LOGO/${id.slice(0, 2)}/${id}/${id}.jpg`;
}

function stationUrl(soopId) {
  const id = String(soopId || '').trim().toLowerCase();
  return /^[a-z0-9]{2,30}$/.test(id) ? `https://www.sooplive.com/station/${encodeURIComponent(id)}` : '';
}

function soopSupportUrl(soopId) {
  const id = String(soopId || '').trim().toLowerCase();
  return /^[a-z0-9]{2,30}$/.test(id) ? `https://m.sooplive.co.kr/item/a/starballoongift?szBjId=${encodeURIComponent(id)}` : '';
}

function openDonationDialog() {
  if (!state.room) return;
  const url = soopSupportUrl(state.room.streamerSoopId);
  if (!url) { showError({ message: 'SOOP 후원 링크를 만들 수 없습니다.' }); return; }
  const nickname = state.room.streamerNickname || '스트리머';
  $('#donation-title').textContent = `${nickname}에게 후원하기`;
  $('#donation-copy').textContent = 'SOOP 후원창은 새 탭으로 열려요. 후원 후 돌아와 완료 알림을 보내면 스트리머에게 채팅으로 전달돼요.';
  const openLink = $('#donation-open-link');
  openLink.href = url;
  openLink.setAttribute('aria-label', `${nickname}의 SOOP 후원창을 새 탭으로 열기`);
  openDialog('donation-dialog');
}

async function sendDonationNotice() {
  const button = $('#donation-notice-button');
  if (!state.room || !state.session || button.disabled) return;
  const nickname = String(state.session.profile && state.session.profile.nickname || '참여자')
    .replace(/[\r\n]+/g, ' ').slice(0, 30);
  const notice = `🎁 ${nickname}님이 SOOP 후원 완료를 알렸어요. (참여자 직접 등록 · 후원 여부 자동 확인 안 됨)`;
  button.disabled = true;
  try {
    const sent = await sendMessage('text', '', '', notice, state.isOwner ? 'broadcast' : null);
    if (sent) {
      closeDialog('donation-dialog');
      showToast('후원 완료 알림을 채팅방에 보냈어요.');
    }
  } finally {
    button.disabled = false;
  }
}

function renderStreamerAvatar(host, src, nickname) {
  host.replaceChildren();
  const fallback = String(nickname || '✦').slice(0, 1);
  if (!src) { host.textContent = fallback; return; }
  const img = document.createElement('img'); img.src = src; img.alt = '';
  img.addEventListener('error', () => { host.replaceChildren(); host.textContent = fallback; }, { once: true });
  host.appendChild(img);
}

function openDialog(id) { const dialog = document.getElementById(id); if (dialog && !dialog.open) dialog.showModal(); }
function closeDialog(id) { const dialog = document.getElementById(id); if (dialog && dialog.open) dialog.close(); }
function setRoomEntryLoading(loading) { $('#room-entry-overlay').hidden = !loading; }

function syncHeader() {
  const session = state.session || {};
  const profileButton = $('#profile-button');
  const profile = session.profile || {};
  if (session.trusted && profile.nickname) {
    profileButton.textContent = profile.nickname;
    const src = profile.avatarUrl || avatarUrl(profile.soopId);
    if (src) {
      profileButton.textContent = '';
      const img = document.createElement('img'); img.src = src; img.alt = '';
      const span = document.createElement('span'); span.textContent = profile.nickname;
      profileButton.append(img, span);
    }
  } else profileButton.textContent = session.trusted ? '프로필 설정' : '로그인';
  $('#create-room-button').hidden = !session.isVerifiedStreamer && !session.isAdmin;
  $('#admin-tab-button').hidden = !session.isAdmin;
  const hasRoom = (session.isVerifiedStreamer || session.isAdmin) && !!session.ownRoom;
  $('#create-room-desktop-label').textContent = hasRoom ? '내 채팅방' : '채팅방 만들기';
  $('#create-room-mobile-label').textContent = hasRoom ? '내 방' : '방 만들기';
  $('#my-rooms-button').hidden = !session.trusted;
  $('#my-rooms-count').textContent = String(state.myRooms.length);
  $('#my-rooms-button').setAttribute('aria-label', `참여 중인 방 ${state.myRooms.length}개 빠른 이동`);
  $('#my-rooms-button').title = `참여 중인 방 ${state.myRooms.length}개 빠른 이동`;
}

async function loadMyRooms(force = false) {
  const uid = state.session && state.session.uid;
  if (!state.session || !state.session.trusted || !uid) return [];
  if (!force && state.myRoomsLoaded && state.myRoomsUid === uid) return state.myRooms;
  if (state.myRoomsPromise && state.myRoomsUid === uid) {
    if (!force) return state.myRoomsPromise;
    await state.myRoomsPromise.catch(() => {});
    if (!state.session || !state.session.trusted || state.session.uid !== uid) return [];
  }
  state.myRoomsUid = uid;
  const request = (async () => {
    const result = await call('messengerListMyRooms');
    if (!state.session || !state.session.trusted || state.session.uid !== uid) return [];
    state.myRooms = (Array.isArray(result.rooms) ? result.rooms : []).filter((room) => room && room.roomId);
    state.myRoomsLoaded = true;
    syncHeader();
    return state.myRooms;
  })();
  state.myRoomsPromise = request;
  try { return await request; }
  finally { if (state.myRoomsPromise === request) state.myRoomsPromise = null; }
}

function renderMyRooms() {
  const host = $('#my-rooms-list');
  host.replaceChildren();
  if (!state.myRooms.length) {
    const empty = document.createElement('div'); empty.className = 'my-rooms-state';
    empty.innerHTML = '<strong>참여 중인 방이 없어요</strong><span>스트리머가 초대를 승인하면 이곳에서 바로 이동할 수 있어요.</span>';
    host.appendChild(empty); return;
  }
  state.myRooms.forEach((room) => {
    const entry = document.createElement('div'); entry.className = 'my-room-entry';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'my-room-item';
    const avatar = document.createElement('span'); avatar.className = 'my-room-avatar';
    renderStreamerAvatar(avatar, room.streamerAvatarUrl || avatarUrl(room.streamerSoopId), room.streamerNickname);
    const details = document.createElement('span'); details.className = 'my-room-details';
    const name = document.createElement('strong'); name.textContent = room.streamerNickname || '스트리머';
    const soopId = document.createElement('small'); soopId.textContent = room.streamerSoopId ? `SOOP ${room.streamerSoopId}` : '스트리머 채팅방';
    details.append(name, soopId);
    const status = document.createElement('span'); status.className = `my-room-status${room.visibility === 'private' ? ' private' : ''}`;
    status.textContent = room.visibility === 'private' ? '🔒 비공개' : '바로 이동';
    button.append(avatar, details, status);
    button.addEventListener('click', () => { closeDialog('my-rooms-dialog'); selectRoom(room); });
    entry.appendChild(button);
    host.appendChild(entry);
  });
}

async function openMyRoomsDialog() {
  const host = $('#my-rooms-list');
  host.innerHTML = '<div class="my-rooms-state">참여 중인 방을 불러오는 중…</div>';
  openDialog('my-rooms-dialog');
  try { await loadMyRooms(true); renderMyRooms(); }
  catch (error) {
    host.replaceChildren();
    const failed = document.createElement('div'); failed.className = 'my-rooms-state';
    const message = document.createElement('span'); message.textContent = '참여 중인 방 목록을 불러오지 못했어요.';
    const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'button button-quiet'; retry.textContent = '다시 불러오기';
    retry.addEventListener('click', openMyRoomsDialog);
    failed.append(message, retry); host.appendChild(failed);
  }
}

function renderRooms() {
  const list = $('#room-list'); list.replaceChildren();
  const queryText = $('#room-search').value.trim().toLocaleLowerCase();
  const entries = state.rooms.filter((room) => {
    const text = `${room.streamerNickname || ''} ${room.streamerSoopId || ''}`.toLocaleLowerCase();
    return !queryText || text.includes(queryText);
  });
  $('#room-empty').hidden = entries.length !== 0;
  if (!entries.length) return;
  for (const room of entries) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'room-card';
    button.title = `${room.streamerNickname || '스트리머'} 채팅방 열기`;
    const top = document.createElement('div'); top.className = 'room-card-top';
    const avatar = document.createElement('div'); avatar.className = 'room-avatar';
    renderStreamerAvatar(avatar, room.streamerAvatarUrl || avatarUrl(room.streamerSoopId), room.streamerNickname);
    const identity = document.createElement('div'); identity.className = 'room-identity';
    const name = document.createElement('strong'); name.textContent = room.streamerNickname || '스트리머';
    const soopId = document.createElement('small'); soopId.textContent = room.streamerSoopId ? `SOOP ${room.streamerSoopId}` : (room.roomType === 'admin' ? '관리자 운영' : '스트리머 인증 완료');
    identity.append(name, soopId);
    top.append(avatar, identity);
    if (room.visibility === 'private') {
      const lock = document.createElement('span'); lock.className = 'room-lock'; lock.textContent = '🔒'; lock.setAttribute('aria-hidden', 'true');
      top.append(lock);
    }
    const desc = document.createElement('p'); desc.className = 'room-description'; desc.textContent = '스트리머가 신청을 확인한 뒤 대화에 초대해요.';
    const foot = document.createElement('div'); foot.className = 'room-card-foot';
    const badge = document.createElement('span'); badge.className = `room-state-pill${room.visibility === 'private' ? ' private' : ''}${room.locked ? ' locked' : ''}`; badge.textContent = room.locked ? '잠금' : (room.visibility === 'private' ? '비공개방' : '공개방');
    const count = document.createElement('span'); count.textContent = room.visibility === 'private' ? '참여 인원 비공개' : `${room.memberCount || 0}명 참여`;
    foot.append(badge, count); button.append(top, desc, foot);
    button.addEventListener('click', () => selectRoom(room)); list.appendChild(button);
  }
}

function sortRooms() {
  state.rooms.sort((a, b) => String(a.streamerNickname).localeCompare(String(b.streamerNickname), 'ko'));
}

function upsertRoom(room) {
  if (!room || !room.roomId) return;
  state.rooms = state.rooms.filter((item) => item.roomId !== room.roomId);
  state.rooms.push(room); sortRooms(); renderRooms();
}

function clearApplicationStatusSubscriptions() {
  state.applicationStatusUnsubscribers.forEach((unsubscribe) => { try { unsubscribe(); } catch (_) {} });
  state.applicationStatusUnsubscribers = [];
}

function notifyApplicationResult(room, status) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const copy = {
    approved: ['대화 신청 승인', `${room.streamerNickname || '스트리머'} 채팅방 신청이 승인되었어요.`],
    rejected: ['대화 신청 거절', `${room.streamerNickname || '스트리머'} 채팅방 신청이 거절되었어요.`],
    expired: ['대화 신청 만료', `${room.streamerNickname || '스트리머'} 채팅방 신청이 만료되었어요.`],
  }[status];
  if (!copy) return;
  const notification = new Notification(copy[0], { body: copy[1], tag: `messenger-application-result-${room.roomId}` });
  notification.onclick = () => { window.focus(); selectRoom(room); notification.close(); };
}

function subscribeApplicationResults() {
  clearApplicationStatusSubscriptions();
  const uid = state.session && state.session.uid;
  if (!uid || !state.rooms.length) return;
  const { db, ref, onValue } = api();
  for (const room of state.rooms) {
    if (!room || !/^[a-z0-9]{2,30}$/.test(room.roomId || '')) continue;
    let initialized = false;
    let previousStatus = '';
    const unsubscribe = onValue(ref(db, `streamerMessenger/rooms/${room.roomId}/applications/${uid}`), (snapshot) => {
      const application = snapshot.val() || null;
      const status = application && application.status || '';
      if (initialized && previousStatus === 'pending' && ['approved', 'rejected', 'expired'].includes(status)) {
        notifyApplicationResult(room, status);
      }
      previousStatus = status;
      initialized = true;
    }, (error) => console.warn('신청 상태를 구독하지 못했습니다.', error));
    state.applicationStatusUnsubscribers.push(unsubscribe);
  }
}

function clearOwnerApplicationSubscription() {
  if (state.ownerApplicationsUnsubscribe) state.ownerApplicationsUnsubscribe();
  state.ownerApplicationsUnsubscribe = null;
  state.ownerApplicationsRoomId = '';
}

function notifyNewApplications(room, arrivals) {
  if (!arrivals.length || !('Notification' in window) || Notification.permission !== 'granted') return;
  const body = arrivals.length === 1
    ? `${arrivals[0].profile && arrivals[0].profile.nickname || '팬'}님이 대화를 신청했어요.`
    : `${arrivals.length}건의 대화 신청이 도착했어요.`;
  const notification = new Notification('새 대화 신청', { body, tag: `messenger-application-${room.roomId}` });
  notification.onclick = async () => {
    window.focus();
    if (!state.isOwner || !state.room || state.room.roomId !== room.roomId) await openOwnRoom();
    switchAside('requests'); notification.close();
  };
}

function subscribeOwnerApplications(room) {
  const uid = state.session && state.session.uid;
  if (!uid || !room || !/^[a-z0-9]{2,30}$/.test(room.roomId || '')) return;
  if (state.ownerApplicationsRoomId === room.roomId && state.ownerApplicationsUnsubscribe) return;
  clearOwnerApplicationSubscription();
  const { db, ref, onValue } = api();
  let initialized = false;
  let knownUids = new Set();
  state.ownerApplicationsRoomId = room.roomId;
  state.ownerApplicationsUnsubscribe = onValue(ref(db, `streamerMessenger/rooms/${room.roomId}/applications`), (snapshot) => {
    const pending = [];
    snapshot.forEach((child) => {
      const application = child.val() || {};
      if (application.status === 'pending' && Number(application.expiresAt) > Date.now()) {
        pending.push({ ...application, uid: application.uid || child.key });
      }
    });
    pending.sort((a, b) => Number(a.submittedAt) - Number(b.submittedAt));
    const currentUids = new Set(pending.map((application) => application.uid));
    if (initialized) {
      notifyNewApplications(room, pending.filter((application) => !knownUids.has(application.uid)));
    }
    initialized = true;
    knownUids = currentUids;
    state.knownApplicationUids = currentUids;
    state.applications = pending;
    if (state.isOwner && state.room && state.room.roomId === room.roomId) renderApplications();
  }, (error) => console.warn('새 대화 신청을 구독하지 못했습니다.', error));
}

async function loadRooms() {
  const { db, ref, get } = api();
  try {
    const snapshot = await get(ref(db, 'streamerMessenger/publicRooms'));
    const data = snapshot.val() || {};
    state.rooms = Object.values(data).filter((room) => room && room.roomId); sortRooms();
    renderRooms();
    subscribeApplicationResults();
    await ensureVerifiedStreamerRoom();
    if (state.session && state.session.isAdmin) {
      try {
        await call('messengerAdminBackfillVerifiedRooms');
        const refreshed = await get(ref(db, 'streamerMessenger/publicRooms'));
        state.rooms = Object.values(refreshed.val() || {}).filter((room) => room && room.roomId);
        sortRooms(); renderRooms(); subscribeApplicationResults();
      } catch (error) {
        console.error('기존 인증 스트리머 방을 채우지 못했습니다.', error);
      }
    }
    await openLinkedStreamerRoom();
  } catch (error) {
    console.error('채팅방 목록을 불러오지 못했습니다.', error);
    $('#room-list').innerHTML = '<div class="loading-card">채팅방 목록을 불러오지 못했어요. 새로고침해 주세요.</div>';
  }
}

async function ensureVerifiedStreamerRoom() {
  const session = state.session;
  if (!session || !session.isVerifiedStreamer || session.ownRoom || !session.uid) return;
  if (state.autoRoomEnsureUid === session.uid && state.autoRoomEnsurePromise) return state.autoRoomEnsurePromise;

  const uid = session.uid;
  state.autoRoomEnsureUid = uid;
  state.autoRoomEnsurePromise = (async () => {
    try {
      const result = await call('messengerEnsureRoom');
      if (!state.session || state.session.uid !== uid) return;
      state.session.ownRoom = result.room;
      subscribeOwnerApplications(result.room);
      syncHeader();
      upsertRoom(result.room);
    } catch (error) {
      console.warn('인증 스트리머 채팅방 자동 확인을 완료하지 못했습니다.', error);
      if (state.autoRoomEnsureUid === uid) state.autoRoomEnsureUid = '';
    } finally {
      if (state.autoRoomEnsureUid === uid) state.autoRoomEnsurePromise = null;
    }
  })();
  return state.autoRoomEnsurePromise;
}

async function openLinkedStreamerRoom() {
  if (state.streamerLinkHandled) return;
  const streamerSoopId = String(new URLSearchParams(window.location.search).get('streamer') || '').trim().toLowerCase();
  if (!/^[a-z0-9]{2,30}$/.test(streamerSoopId)) return;
  state.streamerLinkHandled = true;

  const matchingRooms = state.rooms
    .filter((room) => String(room.streamerSoopId || '').trim().toLowerCase() === streamerSoopId && (room.roomType || 'streamer') === 'streamer')
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
  const ownRoom = state.session && state.session.ownRoom;
  const room = matchingRooms[0] || (ownRoom
    && String(ownRoom.streamerSoopId || '').trim().toLowerCase() === streamerSoopId
    && (ownRoom.roomType || 'streamer') === 'streamer' ? ownRoom : null);
  if (!room) {
    $('#room-search').value = streamerSoopId;
    renderRooms();
    showToast('아직 해당 스트리머의 채팅방이 열리지 않았어요.');
    return;
  }

  if (!state.session || !state.session.trusted) {
    state.pendingStreamerRoom = room;
    openDialog('auth-dialog');
    return;
  }
  await selectRoom(room);
}

async function selectRoom(room) {
  if (!state.session || !state.session.trusted) { openDialog('auth-dialog'); return; }
  setRoomEntryLoading(true);
  try {
    const result = await call('messengerGetRoomState', { roomId: room.roomId });
    if (result.blocked) { showError({ message: '이 채팅방에서 차단되어 다시 신청할 수 없습니다.' }); return; }
    if (result.isOwner || (result.member && result.member.status === 'active')) { await openChat(result.room, result.isOwner); return; }
    if (result.application && result.application.status === 'pending' && Date.now() < Number(result.application.expiresAt || 0)) {
      showError({ message: '대화 신청이 검토 중입니다. 스트리머의 처리를 기다려 주세요.' }); return;
    }
    if (result.application && result.application.status === 'rejected' && Date.now() < Number(result.application.reapplyAt || 0)) {
      showError({ message: '거절 후 3일이 지나야 다시 신청할 수 있습니다.' }); return;
    }
    state.room = room;
    $('#application-title').textContent = `${room.streamerNickname || '스트리머'}에게 대화 신청`;
    $('#application-password-wrap').hidden = room.visibility !== 'private';
    $('#application-password').value = '';
    $('#application-intro').value = '';
    $('#application-error').hidden = true;
    openDialog('application-dialog');
  } catch (error) { showError(error); }
  finally { setRoomEntryLoading(false); }
}

async function openChat(room, isOwner) {
  state.room = room; state.isOwner = isOwner; state.selectedFanUid = ''; state.currentReply = null;
  state.miniGame = null; state.miniGameSelectedLane = -1; state.miniGameSelectedId = ''; state.miniGameMutationPending = false;
  state.miniGameCollapsed = false;
  state.activeRoomTool = 'market'; state.roomToolTabKeys = ''; state.renderedMiniGameId = '';
  $('#room-tools-sticky-slot').hidden = true;
  $('#room-tool-market-slide').hidden = true;
  $('#room-tool-mini-game-slide').hidden = true;
  $('#room-market-panel').hidden = true;
  $('#mini-game-active').hidden = true;
  state.pinnedMessageLoadToken += 1; state.pinnedMessagePointer = null; state.pinnedMessageDetails = null; state.pinnedMessageLoading = false; state.pinActionPending = false;
  renderPinnedMessage();
  state.knownApplicationUids = new Set();
  $('#page-shell').classList.add('chat-open');
  $('#directory-view').hidden = true; $('#admin-view').hidden = true; $('#chat-view').hidden = false;
  $('#streamer-aside').hidden = !isOwner;
  if (isOwner) switchAside('fans');
  $('#member-action').hidden = true;
  $('#chat-title').textContent = isOwner ? '내 채팅방' : `${room.streamerNickname || '스트리머'} 채팅방`;
  $('#chat-subtitle').textContent = isOwner ? '팬별 메시지를 통합 타임라인으로 확인해요' : (room.roomType === 'admin' ? '나와 관리자만 보이는 대화' : `SOOP ${room.streamerSoopId || ''} · 나와 스트리머만 보이는 대화`);
  const fanpageLink = $('#chat-fanpage-link');
  const streamerSoopId = String(room.streamerSoopId || '').trim();
  const isOwnRoom = state.isOwner === true;
  const donationLink = $('#chat-donation-link');
  const supportUrl = soopSupportUrl(streamerSoopId);
  const canDonate = ((room.roomType || 'streamer') === 'streamer' || isOwnRoom) && !!supportUrl;
  donationLink.hidden = !canDonate;
  if (canDonate) {
    const donationLabel = `${room.streamerNickname || '스트리머'}에게 SOOP 후원하기`;
    donationLink.setAttribute('aria-label', donationLabel);
    donationLink.title = donationLabel;
  }
  const hasFanpage = (room.roomType === 'streamer' || isOwnRoom) && /^[a-z0-9]{2,20}$/i.test(streamerSoopId);
  fanpageLink.hidden = !hasFanpage;
  if (hasFanpage) {
    fanpageLink.href = `https://neezu-crypto.github.io/streamer-fanpage/#/p/${encodeURIComponent(streamerSoopId.toLowerCase())}`;
    fanpageLink.setAttribute('aria-label', `${room.streamerNickname || '스트리머'} 팬페이지 열기`);
    fanpageLink.title = `${room.streamerNickname || '스트리머'} 팬페이지 열기`;
  } else {
    fanpageLink.removeAttribute('href');
  }
  applyChatTooltips(room);
  const src = room.streamerAvatarUrl || avatarUrl(room.streamerSoopId);
  renderStreamerAvatar($('#chat-avatar'), src, room.streamerNickname);
  renderRoomState(room);
  clearSubscriptions();
  state.galleryImages.clear(); state.imageUrls.clear();
  state.linkPreviewCache.clear();
  state.privateMessages = []; state.broadcastMessages = []; state.seenMessageIds = new Set();
  state.messages = []; state.olderMessages = []; state.olderPrivateMessages = []; state.olderBroadcastMessages = [];
  state.liveMessages = []; state.hasOlderMessages = false; state.hasOlderPrivateMessages = false; state.hasOlderBroadcastMessages = false;
  state.olderMessagesExhausted = false; state.olderPrivateMessagesExhausted = false; state.olderBroadcastMessagesExhausted = false;
  state.loadingOlderMessages = false; state.optimisticMessages = [];
  state.notificationsPrimed = false; state.timelineLoaded = { owner: false, private: false, broadcast: false };
  if (isOwner) await loadStreamerLists();
  subscribeTimeline();
  subscribeRoomMarket();
  state.activeView = 'chat';
  // 모바일은 긴 방 목록의 스크롤 위치를 채팅 화면에 그대로 가져올 수 있어
  // 채팅 상단의 공유 종목판이 화면 밖에 남지 않도록 진입 시 페이지를 올린다.
  if (window.matchMedia('(max-width: 680px)').matches) window.scrollTo(0, 0);
}

function renderRoomState(room) {
  const pill = $('#room-state-pill'); pill.textContent = room.locked ? '잠금' : (room.visibility === 'private' ? '비공개방' : '공개방');
  pill.className = `room-state-pill${room.visibility === 'private' ? ' private' : ''}${room.locked ? ' locked' : ''}`;
  $('#lock-banner').hidden = !room.locked;
  $('#message-input').disabled = room.locked && !state.isOwner;
  $('#send-message').disabled = room.locked && !state.isOwner;
  $('#open-image-picker').disabled = room.locked && !state.isOwner;
  $('#composer-hint').textContent = room.locked && !state.isOwner ? '채팅방이 잠겨 있어 메시지를 보낼 수 없어요.' : '메시지는 최대 7일 보관돼요.';
  $('#streamer-compose-options').hidden = !state.isOwner;
}

function clearSubscriptions() {
  for (const unsubscribe of state.unsubscribers) { try { unsubscribe(); } catch (_) {} }
  state.unsubscribers = [];
  state.roomMarketQuoteUnsubscribers = new Map();
}

function subscribePinnedMessage() {
  const roomId = state.room && state.room.roomId;
  if (!roomId) return;
  const { db, ref, onValue, get } = api();
  const pinnedRef = ref(db, `streamerMessenger/rooms/${roomId}/meta/pinnedMessage`);
  const unsubscribe = onValue(pinnedRef, (snapshot) => {
    if (!state.room || state.room.roomId !== roomId) return;
    const value = snapshot.val();
    const messageId = value && String(value.messageId || '');
    const pointer = messageId && /^[A-Za-z0-9_-]{20}$/.test(messageId) ? value : null;
    const loadToken = ++state.pinnedMessageLoadToken;
    state.pinnedMessagePointer = pointer;
    state.pinnedMessageDetails = null;
    state.pinnedMessageLoading = !!pointer;
    renderPinnedMessage();
    renderTimeline({ preservePosition: true });
    if (!pointer) return;
    if (pointer.message) {
      const message = pointer.message;
      const validSnapshot = message.id === messageId && message.roomId === roomId
        && Number(message.createdAt) === Number(pointer.messageCreatedAt)
        && ['streamer', 'fan'].includes(message.senderRole) && ['text', 'image'].includes(message.kind)
        && (message.kind !== 'text' || typeof message.text === 'string')
        && (message.kind !== 'image' || typeof message.galleryImageId === 'string');
      state.pinnedMessageDetails = validSnapshot ? message : null;
      state.pinnedMessageLoading = false;
      renderPinnedMessage();
      renderTimeline({ preservePosition: true });
      return;
    }
    get(ref(db, `streamerMessenger/chat/${roomId}/broadcast/${messageId}`)).then((messageSnapshot) => {
      if (!state.room || state.room.roomId !== roomId || state.pinnedMessageLoadToken !== loadToken) return;
      const message = messageSnapshot.val();
      const isRoomWideMessage = message && message.id === messageId && message.roomId === roomId
        && message.senderRole === 'streamer' && !message.recipientUid && ['text', 'image'].includes(message.kind)
        && Number(message.createdAt) === Number(pointer.messageCreatedAt);
      state.pinnedMessageDetails = isRoomWideMessage ? message : null;
      state.pinnedMessageLoading = false;
      renderPinnedMessage();
      renderTimeline({ preservePosition: true });
    }).catch((error) => {
      if (!state.room || state.room.roomId !== roomId || state.pinnedMessageLoadToken !== loadToken) return;
      console.warn('고정 메시지를 불러오지 못했습니다.', error);
      state.pinnedMessageLoading = false;
      renderPinnedMessage();
    });
  }, (error) => {
    if (!state.room || state.room.roomId !== roomId) return;
    console.warn('고정 메시지 상태를 구독하지 못했습니다.', error);
    state.pinnedMessagePointer = null;
    state.pinnedMessageDetails = null;
    state.pinnedMessageLoading = false;
    renderPinnedMessage();
  });
  state.unsubscribers.push(unsubscribe);
}

function normalizeMiniGame(value) {
  if (!value || value.gameType !== 'ladder' || value.status !== 'active'
    || !Number.isFinite(Number(value.expiresAt)) || Number(value.expiresAt) <= Date.now()
    || !Array.isArray(value.players) || !Array.isArray(value.outcomes) || !Array.isArray(value.rungs)) return null;
  return value;
}

function applyMiniGameState(value) {
  const game = normalizeMiniGame(value);
  state.miniGame = game;
  state.miniGameSelectedId = game && game.gameId || '';
  state.miniGameSelectedLane = game && Number.isInteger(game.selectedLane) && game.selectedLane >= 0 && game.selectedLane < game.players.length
    ? game.selectedLane : -1;
  return game;
}

function subscribeMiniGame() {
  const roomId = state.room && state.room.roomId;
  if (!roomId) return;
  const { db, ref, onValue } = api();
  const gameRef = ref(db, `streamerMessenger/rooms/${roomId}/meta/miniGame`);
  state.unsubscribers.push(onValue(gameRef, (snapshot) => {
    if (!state.room || state.room.roomId !== roomId) return;
    applyMiniGameState(snapshot.val());
    $('#mini-game-live-error').hidden = true;
    renderMiniGame();
  }, (error) => {
    console.warn('채팅방 미니게임을 구독하지 못했습니다.', error);
    state.miniGame = null;
    renderMiniGame('미니게임 정보를 불러오지 못했습니다.');
  }));
}

function subscribeTimeline() {
  clearSubscriptions();
  const { db, ref, onValue, query, orderByKey, limitToLast } = api();
  const roomId = state.room.roomId;
  subscribePinnedMessage();
  subscribeMiniGame();
  if (!state.isOwner) {
    const uid = state.session.uid;
    let memberStatusInitialized = false;
    const membershipRef = ref(db, `streamerMessenger/rooms/${roomId}/members/${uid}/status`);
    state.unsubscribers.push(onValue(membershipRef, (snapshot) => {
      if (!state.room || state.room.roomId !== roomId || state.isOwner) return;
      const status = snapshot.val();
      if (!memberStatusInitialized) {
        memberStatusInitialized = true;
        if (status === 'active') return;
      } else if (status === 'active') return;
      leaveChat();
      showToast('채팅방 참여가 종료되어 대화를 닫았습니다.');
    }, (error) => {
      console.warn('채팅방 참여 상태를 구독하지 못했습니다.', error);
      if (error && error.code === 'PERMISSION_DENIED' && state.room && state.room.roomId === roomId) {
        leaveChat();
        showToast('채팅방 접근 권한이 종료되어 대화를 닫았습니다.');
      }
    }));
  }
  if (state.isOwner) {
    const q = query(ref(db, `streamerMessenger/chat/${roomId}/streamerTimeline`), orderByKey(), limitToLast(MESSAGE_PAGE_SIZE));
    state.unsubscribers.push(onValue(q, (snap) => {
      state.liveMessages = Object.values(snap.val() || {});
      state.hasOlderMessages = !state.olderMessagesExhausted && (state.liveMessages.length >= MESSAGE_PAGE_SIZE || state.olderMessages.length > 0);
      state.timelineLoaded.owner = true;
      discardAcknowledgedOptimisticMessages(state.liveMessages);
      state.messages = combineMessages(state.olderMessages, state.liveMessages, state.optimisticMessages);
      trackNotifications(state.liveMessages);
      renderTimeline();
    }, showError));
    return;
  }
  const own = ref(db, `streamerMessenger/chat/${roomId}/private/${state.session.uid}`);
  const broadcast = ref(db, `streamerMessenger/chat/${roomId}/broadcast`);
  state.unsubscribers.push(onValue(query(own, orderByKey(), limitToLast(MESSAGE_PAGE_SIZE)), (snap) => {
    state.privateMessages = Object.values(snap.val() || {});
    state.hasOlderPrivateMessages = !state.olderPrivateMessagesExhausted && (state.privateMessages.length >= MESSAGE_PAGE_SIZE || state.olderPrivateMessages.length > 0);
    state.timelineLoaded.private = true;
    mergeFanMessages();
  }, showError));
  state.unsubscribers.push(onValue(query(broadcast, orderByKey(), limitToLast(MESSAGE_PAGE_SIZE)), (snap) => {
    state.broadcastMessages = Object.values(snap.val() || {});
    state.hasOlderBroadcastMessages = !state.olderBroadcastMessagesExhausted && (state.broadcastMessages.length >= MESSAGE_PAGE_SIZE || state.olderBroadcastMessages.length > 0);
    state.timelineLoaded.broadcast = true;
    mergeFanMessages();
  }, showError));
}

function mergeFanMessages() {
  const live = combineMessages(state.privateMessages || [], state.broadcastMessages || []);
  discardAcknowledgedOptimisticMessages(live);
  state.hasOlderMessages = state.hasOlderPrivateMessages || state.hasOlderBroadcastMessages;
  state.messages = combineMessages(state.olderPrivateMessages, state.olderBroadcastMessages, live, state.optimisticMessages);
  trackNotifications(live);
  renderTimeline();
}

function miniGameLines(selector) {
  return $(selector).value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
}

function canManageMiniGame() {
  return !!state.room && (state.isOwner || (state.session && state.session.isAdmin && state.room.roomType === 'admin'));
}

function setMiniGameCollapsed(collapsed) {
  state.miniGameCollapsed = !!collapsed;
  const panel = $('#mini-game-active');
  $('#room-tool-mini-game-slide').classList.toggle('is-compact', state.miniGameCollapsed);
  const toggle = $('#toggle-mini-game-card');
  panel.classList.toggle('is-collapsed', state.miniGameCollapsed);
  toggle.setAttribute('aria-expanded', String(!state.miniGameCollapsed));
  const label = state.miniGameCollapsed ? '미니게임 영역 펼치기' : '미니게임 영역 접기';
  toggle.setAttribute('aria-label', label);
  toggle.title = label;
  toggle.querySelector('[aria-hidden="true"]').textContent = state.miniGameCollapsed ? '⌄' : '⌃';
}

function availableRoomToolSlides() {
  return Array.from($('#room-tools-track').querySelectorAll('.room-tool-slide')).filter((slide) => !slide.hidden);
}

function renderRoomToolSwitcher(preferredKey = '') {
  const slot = $('#room-tools-sticky-slot');
  const switcher = $('#room-tools-switcher');
  const track = $('#room-tools-track');
  const slides = availableRoomToolSlides();
  if (!state.room || !slides.length) {
    slot.hidden = true;
    switcher.hidden = true;
    track.style.transform = '';
    return;
  }

  slot.hidden = false;
  switcher.hidden = slides.length < 2;
  switcher.classList.toggle('is-scrollable', slides.length >= 3);
  const keys = slides.map((slide) => slide.dataset.roomTool);
  const keySignature = keys.join('|');
  if (state.roomToolTabKeys !== keySignature) {
    const tabs = slides.map((slide) => {
      const key = slide.dataset.roomTool;
      const label = slide.dataset.roomToolLabel || key;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'room-tool-tab';
      button.id = `room-tool-tab-${key}`;
      button.dataset.roomToolTab = key;
      button.setAttribute('role', 'tab');
      button.setAttribute('aria-controls', slide.id);
      button.setAttribute('aria-label', `${label}로 전환`);
      button.title = `${label}로 전환`;
      if (key === 'mini-game') {
        const indicator = document.createElement('span');
        indicator.className = 'room-tool-live-dot';
        indicator.setAttribute('aria-hidden', 'true');
        button.append(indicator);
      }
      const text = document.createElement('span');
      text.textContent = label;
      button.append(text);
      return button;
    });
    switcher.replaceChildren(...tabs);
    state.roomToolTabKeys = keySignature;
  }

  if (preferredKey && keys.includes(preferredKey)) state.activeRoomTool = preferredKey;
  if (!keys.includes(state.activeRoomTool)) state.activeRoomTool = keys[0];
  const activeIndex = keys.indexOf(state.activeRoomTool);
  slides.forEach((slide, index) => {
    const selected = index === activeIndex;
    const key = slide.dataset.roomTool;
    const tab = switcher.querySelector(`[data-room-tool-tab="${key}"]`);
    slide.setAttribute('aria-hidden', String(!selected));
    slide.toggleAttribute('inert', !selected);
    if (tab && slides.length > 1) {
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      slide.setAttribute('aria-labelledby', tab.id);
    } else slide.removeAttribute('aria-labelledby');
  });
  track.style.transform = `translate3d(-${activeIndex * 100}%, 0, 0)`;
  if (slides.length >= 3) {
    const activeTab = switcher.querySelector(`[data-room-tool-tab="${state.activeRoomTool}"]`);
    if (activeTab) {
      const tabLeft = activeTab.offsetLeft - switcher.offsetLeft;
      const tabRight = tabLeft + activeTab.offsetWidth;
      if (tabLeft < switcher.scrollLeft) switcher.scrollTo({ left: tabLeft, behavior: 'smooth' });
      else if (tabRight > switcher.scrollLeft + switcher.clientWidth) {
        switcher.scrollTo({ left: tabRight - switcher.clientWidth, behavior: 'smooth' });
      }
    }
  }
}

function selectRoomTool(key) {
  if (!availableRoomToolSlides().some((slide) => slide.dataset.roomTool === key)) return;
  state.activeRoomTool = key;
  renderRoomToolSwitcher();
}

function switchRoomToolBySwipe(direction) {
  const slides = availableRoomToolSlides();
  if (slides.length < 2) return;
  const currentIndex = slides.findIndex((slide) => slide.dataset.roomTool === state.activeRoomTool);
  if (currentIndex < 0) return;
  const next = slides[currentIndex + direction];
  if (next) selectRoomTool(next.dataset.roomTool);
}

function bindRoomToolControls() {
  const switcher = $('#room-tools-switcher');
  const viewport = $('#room-tools-viewport');
  switcher.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-room-tool-tab]');
    if (tab) selectRoomTool(tab.dataset.roomToolTab);
  });
  switcher.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = Array.from(switcher.querySelectorAll('[data-room-tool-tab]'));
    const currentIndex = tabs.indexOf(document.activeElement);
    const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : (currentIndex + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    const next = tabs[nextIndex];
    if (!next) return;
    event.preventDefault();
    next.focus();
    selectRoomTool(next.dataset.roomToolTab);
  });

  let touchStart = null;
  viewport.addEventListener('touchstart', (event) => {
    if (event.touches.length !== 1 || event.target.closest('button,a,input,textarea,select,.room-market-stock-list,.room-market-feed,.ladder-board-scroll')) {
      touchStart = null;
      return;
    }
    touchStart = { x: event.touches[0].clientX, y: event.touches[0].clientY };
  }, { passive: true });
  viewport.addEventListener('touchend', (event) => {
    if (!touchStart || event.changedTouches.length !== 1) return;
    const deltaX = event.changedTouches[0].clientX - touchStart.x;
    const deltaY = event.changedTouches[0].clientY - touchStart.y;
    touchStart = null;
    if (Math.abs(deltaX) < 48 || Math.abs(deltaX) < Math.abs(deltaY) * 1.25) return;
    switchRoomToolBySwipe(deltaX < 0 ? 1 : -1);
  }, { passive: true });
  viewport.addEventListener('touchcancel', () => { touchStart = null; }, { passive: true });
}

function renderMiniGame(errorMessage = '') {
  const game = state.miniGame;
  const setup = $('#mini-game-setup');
  const waiting = $('#mini-game-waiting');
  const active = $('#mini-game-active');
  const gameSlide = $('#room-tool-mini-game-slide');
  const start = $('#mini-game-start');
  const clear = $('#mini-game-clear');
  const error = $('#mini-game-error');
  const liveError = $('#mini-game-live-error');
  error.textContent = errorMessage;
  error.hidden = !errorMessage;
  const canManage = canManageMiniGame();
  setup.hidden = !!game || !canManage;
  waiting.hidden = !!game || canManage;
  active.hidden = !game;
  gameSlide.hidden = !game;
  const gameId = game && game.gameId || '';
  const gameStarted = !!gameId && gameId !== state.renderedMiniGameId;
  const gameFinished = !gameId && !!state.renderedMiniGameId && state.activeRoomTool === 'mini-game';
  state.renderedMiniGameId = gameId;
  setMiniGameCollapsed(state.miniGameCollapsed);
  start.disabled = state.miniGameMutationPending;
  clear.hidden = !game || !canManage;
  clear.disabled = state.miniGameMutationPending;
  clear.textContent = game && game.finishClaim ? '결과 공유 다시 시도' : '종료하고 결과 공유';
  clear.title = game && game.finishClaim
    ? '결과 공유가 완료되지 않았어요. 같은 결과 공유를 다시 시도합니다.'
    : '사다리를 종료하고 전체 결과를 채팅방에 공유합니다';
  if (!game) {
    $('#ladder-board').replaceChildren();
    $('#mini-game-result').textContent = '스트리머가 참가자를 선택하면 경로와 결과가 표시됩니다.';
    liveError.hidden = true;
    renderRoomToolSwitcher(gameFinished ? 'market' : '');
    return;
  }

  const players = game.players.slice(0, 8);
  const outcomes = game.outcomes.slice(0, 8);
  const rungs = Array.from({ length: Math.min(game.rungs.length, 10) }, (_, index) => (
    Array.isArray(game.rungs[index]) ? game.rungs[index] : []
  ));
  if (players.length < 2 || players.length > 8 || outcomes.length !== players.length) {
    liveError.textContent = '사다리 데이터 형식이 올바르지 않습니다.';
    liveError.hidden = false;
    return;
  }
  const board = $('#ladder-board');
  board.replaceChildren();
  board.style.width = `${Math.max(320, players.length * 76 + 32)}px`;
  const laneCount = players.length;
  const top = document.createElement('div');
  top.className = 'ladder-choices';
  top.style.gridTemplateColumns = `repeat(${laneCount}, minmax(0, 1fr))`;
  players.forEach((name, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `ladder-choice${state.miniGameSelectedLane === index ? ' selected' : ''}`;
    button.textContent = name;
    button.title = canManage
      ? `${name} 참가자의 경로를 모든 참여자 화면에 표시합니다`
      : `스트리머가 선택하면 ${name} 참가자의 경로가 모든 참여자에게 표시됩니다`;
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-pressed', String(state.miniGameSelectedLane === index));
    button.disabled = state.miniGameMutationPending || !!game.finishClaim;
    button.addEventListener('click', () => {
      if (!canManageMiniGame()) {
        showToast('스트리머가 참가자를 선택하면 모두에게 같은 경로가 표시돼요.');
        return;
      }
      updateMiniGame('select', index);
    });
    top.appendChild(button);
  });
  board.appendChild(top);

  const svgWidth = Math.max(320, players.length * 76 + 32);
  const svgHeight = 230;
  const left = 20;
  const right = svgWidth - 20;
  const topY = 16;
  const bottomY = 210;
  const rowCount = Math.max(1, rungs.length);
  const xForLane = (lane) => left + ((right - left) * lane) / (laneCount - 1);
  const yForRow = (row) => topY + ((bottomY - topY) * (row + 1)) / (rowCount + 1);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('ladder-svg');
  svg.setAttribute('viewBox', `0 0 ${svgWidth} ${svgHeight}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '참가자별 사다리 경로');
  const addLine = (x1, y1, x2, y2, className) => {
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', String(x1)); line.setAttribute('y1', String(y1));
    line.setAttribute('x2', String(x2)); line.setAttribute('y2', String(y2));
    line.setAttribute('class', className);
    svg.appendChild(line);
  };
  for (let lane = 0; lane < laneCount; lane += 1) addLine(xForLane(lane), topY, xForLane(lane), bottomY, 'ladder-rail');
  rungs.forEach((row, rowIndex) => row.forEach((edge) => {
    if (!Number.isInteger(edge) || edge < 0 || edge >= laneCount - 1) return;
    addLine(xForLane(edge), yForRow(rowIndex), xForLane(edge + 1), yForRow(rowIndex), 'ladder-rung');
  }));
  let destination = -1;
  if (state.miniGameSelectedLane >= 0 && state.miniGameSelectedLane < laneCount) {
    let lane = state.miniGameSelectedLane;
    const points = [[xForLane(lane), topY]];
    rungs.forEach((row, rowIndex) => {
      const edge = row.find((candidate) => candidate === lane || candidate + 1 === lane);
      points.push([xForLane(lane), yForRow(rowIndex)]);
      if (Number.isInteger(edge)) {
        lane = edge === lane ? lane + 1 : lane - 1;
        points.push([xForLane(lane), yForRow(rowIndex)]);
      }
    });
    destination = lane;
    points.push([xForLane(lane), bottomY]);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    path.setAttribute('points', points.map((point) => point.join(',')).join(' '));
    path.setAttribute('class', 'ladder-selected-path');
    svg.appendChild(path);
    const pathLength = points.slice(1).reduce((length, point, index) => {
      const previous = points[index];
      return length + Math.hypot(point[0] - previous[0], point[1] - previous[1]);
    }, 0);
    path.style.setProperty('--ladder-path-length', String(pathLength));
  }
  board.appendChild(svg);

  const bottom = document.createElement('div');
  bottom.className = 'ladder-outcomes';
  bottom.style.gridTemplateColumns = `repeat(${laneCount}, minmax(0, 1fr))`;
  outcomes.forEach((outcome, index) => {
    const label = document.createElement('span');
    label.className = `ladder-outcome${destination === index ? ' selected' : ''}`;
    label.textContent = outcome;
    label.title = `사다리 ${index + 1}번 결과: ${outcome}`;
    bottom.appendChild(label);
  });
  board.appendChild(bottom);
  $('#mini-game-result').textContent = destination >= 0
    ? `${players[state.miniGameSelectedLane]} → ${outcomes[destination]}`
    : '참가자를 선택하면 결과가 표시됩니다.';
  renderRoomToolSwitcher(gameStarted ? 'mini-game' : '');
}

function openMiniGameDialog() {
  if (!state.room) return;
  if (state.miniGame) {
    selectRoomTool('mini-game');
    $('#room-tools-sticky-slot').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return;
  }
  if (!canManageMiniGame()) {
    showToast('스트리머가 사다리 게임을 시작하면 채팅창에 표시돼요.');
    return;
  }
  setMiniGameCollapsed(false);
  $('#mini-game-error').hidden = true;
  renderMiniGame();
  openDialog('mini-game-dialog');
}

async function updateMiniGame(action, participantIndex = -1) {
  if (!state.room || !canManageMiniGame() || state.miniGameMutationPending) return;
  const button = action === 'start' ? $('#mini-game-start') : $('#mini-game-clear');
  const payload = { roomId: state.room.roomId, action };
  if (action === 'start') {
    const players = miniGameLines('#mini-game-players');
    const outcomes = miniGameLines('#mini-game-outcomes');
    if (players.length < 2 || players.length > 8 || outcomes.length !== players.length) {
      renderMiniGame('참가자와 결과를 각각 2~8개, 같은 개수로 입력해 주세요.');
      return;
    }
    if (players.some((value) => value.length > 24) || outcomes.some((value) => value.length > 24)) {
      renderMiniGame('각 이름은 24자 이하로 입력해 주세요.');
      return;
    }
    if (new Set(players.map((value) => value.toLocaleLowerCase('ko-KR'))).size !== players.length) {
      renderMiniGame('참가자 이름은 서로 다르게 입력해 주세요.');
      return;
    }
    payload.gameType = 'ladder'; payload.players = players; payload.outcomes = outcomes;
  } else if (action === 'select') {
    if (!state.miniGame || !Number.isInteger(participantIndex) || participantIndex < 0 || participantIndex >= state.miniGame.players.length) return;
    if (participantIndex === state.miniGameSelectedLane) return;
    payload.gameId = state.miniGame.gameId;
    payload.participantIndex = participantIndex;
  } else if (action === 'finish') {
    if (!state.miniGame || !window.confirm('사다리를 종료하고 전체 결과를 채팅방 참여자에게 공유할까요?')) return;
  } else return;

  state.miniGameMutationPending = true;
  if (button) button.disabled = true;
  $('#mini-game-error').hidden = true;
  $('#mini-game-live-error').hidden = true;
  renderMiniGame();
  try {
    const result = await call('messengerMiniGameUpdate', payload);
    if (result && Object.prototype.hasOwnProperty.call(result, 'miniGame')) {
      applyMiniGameState(result.miniGame);
      renderMiniGame();
    }
    if (result && result.stale) {
      const staleMessage = action === 'select'
        ? state.miniGame ? '사다리 상태가 바뀌어 경로를 표시하지 못했어요. 최신 상태에서 다시 선택해 주세요.' : '사다리 게임이 종료되어 참가자를 선택할 수 없어요.'
        : state.miniGame ? '사다리 종료를 확정하지 못했어요. 최신 상태를 확인한 뒤 다시 시도해 주세요.' : '이전 사다리 게임은 이미 종료되어 화면을 정리했어요.';
      showToast(staleMessage);
      return;
    }
    if (action === 'start') {
      selectRoomTool('mini-game');
      closeDialog('mini-game-dialog');
      showToast('사다리 게임을 채팅창에 시작했어요.');
      $('#room-tools-sticky-slot').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } else if (action === 'finish') showToast('사다리 결과를 채팅방에 공유했어요.');
  } catch (error) {
    let staleGame = false;
    if (action !== 'start' && payload.gameId && state.room && state.room.roomId === payload.roomId) {
      try {
        const serverState = await call('messengerMiniGameUpdate', { roomId: payload.roomId, action: 'sync' });
        if (!state.room || state.room.roomId !== payload.roomId) return;
        const latest = applyMiniGameState(serverState && serverState.miniGame);
        staleGame = !latest || latest.gameId !== payload.gameId;
        if (staleGame) {
          $('#mini-game-live-error').hidden = true;
          renderMiniGame();
          showToast(latest ? '사다리 상태가 바뀌어 최신 게임으로 화면을 갱신했어요.' : '이전 사다리 게임은 이미 종료되어 화면을 정리했어요.');
        }
      } catch (refreshError) {
        console.warn('사다리 상태를 다시 확인하지 못했습니다.', refreshError);
      }
    }
    if (staleGame) return;
    const errorTarget = action === 'start' ? $('#mini-game-error') : $('#mini-game-live-error');
    errorTarget.textContent = error.message || '미니게임 요청을 처리하지 못했습니다.';
    errorTarget.hidden = false;
  } finally {
    state.miniGameMutationPending = false;
    renderMiniGame();
  }
}

function setRoomMarketCollapsed(collapsed) {
  const panel = $('#room-market-panel');
  $('#room-tool-market-slide').classList.toggle('is-compact', collapsed);
  const content = $('#room-market-content');
  const toggle = $('#toggle-room-market');
  const label = collapsed ? '공유 종목 영역 펼치기' : '공유 종목 영역 접기';
  content.hidden = collapsed;
  panel.classList.toggle('is-collapsed', collapsed);
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.setAttribute('aria-label', label);
  toggle.title = label;
  toggle.querySelector('[aria-hidden="true"]').textContent = collapsed ? '⌄' : '⌃';
}

function subscribeRoomMarket() {
  const panel = $('#room-market-panel');
  const marketSlide = $('#room-tool-market-slide');
  const roomId = state.room && state.room.roomId;
  setRoomMarketCollapsed(true);
  panel.hidden = !roomId;
  marketSlide.hidden = panel.hidden;
  renderRoomToolSwitcher();
  if (panel.hidden) return;
  state.roomMarketStocks = {};
  state.roomMarketFeed = [];
  state.roomMarketQuotes = {};
  state.roomMarketPriceHistory = {};
  state.roomMarketSparklineSeeded = new Set();
  $('#room-market-stock-list').innerHTML = '<p class="room-market-empty">공유 종목을 불러오는 중…</p>';
  $('#room-market-feed').innerHTML = '<p class="room-market-empty">거래 내역을 불러오는 중…</p>';
  const { db, ref, onValue, query, orderByKey, limitToLast } = api();
  state.unsubscribers.push(onValue(ref(db, `streamerMessenger/roomMarkets/${roomId}/stocks`), (snapshot) => {
    if (!state.room || state.room.roomId !== roomId) return;
    state.roomMarketStocks = snapshot.val() || {};
    syncRoomMarketQuoteListeners();
    renderRoomMarketStocks();
    if ($('#room-market-add-dialog').open) renderRoomMarketSearchResults();
  }, (error) => {
    console.warn('채팅방 공유 종목을 구독하지 못했습니다.', error);
    $('#room-market-stock-list').innerHTML = '<p class="room-market-empty">공유 종목을 불러오지 못했습니다.</p>';
  }));
  const feedQuery = query(ref(db, `streamerMessenger/roomMarkets/${roomId}/trades`), orderByKey(), limitToLast(8));
  state.unsubscribers.push(onValue(feedQuery, (snapshot) => {
    if (!state.room || state.room.roomId !== roomId) return;
    state.roomMarketFeed = Object.values(snapshot.val() || {}).sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
    renderRoomMarketFeed();
  }, (error) => {
    console.warn('채팅방 거래 피드를 구독하지 못했습니다.', error);
    $('#room-market-feed').innerHTML = '<p class="room-market-empty">거래 내역을 불러오지 못했습니다.</p>';
  }));
}

function syncRoomMarketQuoteListeners() {
  const { db, ref, onValue } = api();
  const roomId = state.room && state.room.roomId;
  const stockIds = new Set(Object.keys(state.roomMarketStocks || {}));
  for (const [stockId, unsubscribe] of state.roomMarketQuoteUnsubscribers) {
    if (stockIds.has(stockId)) continue;
    unsubscribe();
    state.roomMarketQuoteUnsubscribers.delete(stockId);
    delete state.roomMarketQuotes[stockId];
    delete state.roomMarketPriceHistory[stockId];
    state.roomMarketSparklineSeeded.delete(stockId);
  }
  for (const stockId of stockIds) {
    if (state.roomMarketQuoteUnsubscribers.has(stockId)) continue;
    const unsubscribe = onValue(ref(db, `stocksPublic/${stockId}`), (snapshot) => {
      if (!state.room || state.room.roomId !== roomId) return;
      state.roomMarketQuotes[stockId] = snapshot.val() || null;
      recordRoomMarketPriceTick(stockId, state.roomMarketQuotes[stockId]?.price);
      renderRoomMarketStocks();
      if (state.roomMarketSelectedStockId === stockId && $('#room-market-trade-dialog').open) {
        renderRoomMarketQuote(stockId);
        renderRoomMarketChart(stockId);
      }
    }, (error) => console.warn('채팅방 종목 현재가를 구독하지 못했습니다.', error));
    state.roomMarketQuoteUnsubscribers.set(stockId, unsubscribe);
    state.unsubscribers.push(unsubscribe);
    seedRoomMarketSparkline(stockId);
  }
}

const ROOM_MARKET_PRICE_HISTORY_MAX = 20;

function recordRoomMarketPriceTick(stockId, rawPrice) {
  const price = Number(rawPrice);
  if (!Number.isFinite(price) || price <= 0) return;
  const history = state.roomMarketPriceHistory[stockId] || (state.roomMarketPriceHistory[stockId] = []);
  if (history[history.length - 1] !== price) {
    history.push(price);
    if (history.length > ROOM_MARKET_PRICE_HISTORY_MAX) history.shift();
  }
}

async function seedRoomMarketSparkline(stockId) {
  if (state.roomMarketSparklineSeeded.has(stockId)) return;
  state.roomMarketSparklineSeeded.add(stockId);
  const roomId = state.room?.roomId;
  const { db, ref, get } = api();
  try {
    const snapshot = await get(ref(db, `sparklines/${stockId}`));
    if (!state.room || state.room.roomId !== roomId || !state.roomMarketStocks[stockId]) return;
    const savedHistory = (Array.isArray(snapshot.val()) ? snapshot.val() : [])
      .map(Number).filter((price) => Number.isFinite(price) && price > 0)
      .slice(-ROOM_MARKET_PRICE_HISTORY_MAX);
    const liveHistory = state.roomMarketPriceHistory[stockId] || [];
    if (!savedHistory.length || liveHistory.length >= 2) return;
    const history = savedHistory.slice();
    const latestLivePrice = Number(state.roomMarketQuotes[stockId]?.price || liveHistory[liveHistory.length - 1]);
    if (Number.isFinite(latestLivePrice) && latestLivePrice > 0 && history[history.length - 1] !== latestLivePrice) {
      history.push(latestLivePrice);
    }
    state.roomMarketPriceHistory[stockId] = history.slice(-ROOM_MARKET_PRICE_HISTORY_MAX);
    renderRoomMarketStocks();
  } catch (error) {
    console.warn('채팅방 종목 가격 이력을 불러오지 못했습니다.', error);
  }
}

function getRoomMarketChangePercent(stockId) {
  const history = state.roomMarketPriceHistory[stockId] || [];
  if (history.length < 2 || !history[0]) return '0.00';
  return (((history[history.length - 1] - history[0]) / history[0]) * 100).toFixed(2);
}

function createRoomMarketSparkline(stockId, isUp) {
  const history = state.roomMarketPriceHistory[stockId] || [];
  const quotePrice = Number(state.roomMarketQuotes[stockId]?.price);
  const points = history.length >= 2 ? history : (Number.isFinite(quotePrice) && quotePrice > 0 ? [quotePrice, quotePrice] : []);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `room-market-sparkline${isUp ? ' up' : ' down'}`);
  svg.setAttribute('viewBox', '0 0 80 28');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', `${isUp ? '상승' : '하락'} 가격 흐름`);
  if (points.length < 2) return svg;
  const min = Math.min(...points);
  const range = Math.max(...points) - min || 1;
  const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  polyline.setAttribute('points', points.map((price, index) => `${(index / (points.length - 1)) * 80},${26 - ((price - min) / range) * 24}`).join(' '));
  svg.appendChild(polyline);
  return svg;
}

function renderRoomMarketStocks() {
  const host = $('#room-market-stock-list');
  host.replaceChildren();
  const entries = Object.entries(state.roomMarketStocks || {});
  $('#add-room-stock').disabled = entries.length >= 12;
  if (!entries.length) {
    const empty = document.createElement('div'); empty.className = 'room-market-empty room-market-empty-stock';
    const icon = document.createElement('span'); icon.className = 'room-market-empty-icon'; icon.textContent = '↗'; icon.setAttribute('aria-hidden', 'true');
    const copy = document.createElement('span'); copy.className = 'room-market-empty-copy';
    const title = document.createElement('strong'); title.textContent = '공유 종목이 아직 없어요';
    const description = document.createElement('small'); description.textContent = '종목을 추가해 채팅방에서 함께 거래해 보세요.';
    copy.append(title, description); empty.append(icon, copy); host.appendChild(empty); return;
  }
  entries.sort((a, b) => String(a[1]?.name || '').localeCompare(String(b[1]?.name || ''), 'ko'));
  for (const [stockId, saved] of entries) {
    const quote = state.roomMarketQuotes[stockId] || {};
    const name = quote.name || saved.name || stockId;
    const wrap = document.createElement('div'); wrap.className = 'room-market-stock-wrap';
    const open = document.createElement('button'); open.type = 'button'; open.className = 'room-market-stock-card'; open.title = `${name} 차트와 거래 열기`; open.setAttribute('aria-label', open.title);
    const title = document.createElement('strong'); title.textContent = name;
    const price = document.createElement('small'); price.textContent = Number.isFinite(Number(quote.price)) ? `${Number(quote.price).toLocaleString('ko-KR')}원` : '현재가 불러오는 중';
    const changeValue = Number(getRoomMarketChangePercent(stockId));
    const isUp = changeValue >= 0;
    const change = document.createElement('span'); change.className = `room-market-stock-change ${isUp ? 'up' : 'down'}`;
    change.textContent = `${isUp ? '+' : ''}${changeValue.toFixed(2)}%`;
    const metrics = document.createElement('div'); metrics.className = 'room-market-stock-metrics'; metrics.append(price, change);
    open.append(title, metrics, createRoomMarketSparkline(stockId, isUp)); open.addEventListener('click', () => openRoomMarketTrade(stockId));
    wrap.appendChild(open);
    if (state.isOwner) {
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'room-market-remove'; remove.textContent = '×'; remove.title = `${name} 공유 종목 제거`; remove.setAttribute('aria-label', `${name} 공유 종목 제거`);
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        try { await call('messengerRoomMarketUpdate', { roomId: state.room.roomId, stockId, action: 'remove' }); }
        catch (error) { showError(error, '공유 종목을 제거하지 못했습니다.'); remove.disabled = false; }
      });
      wrap.appendChild(remove);
    }
    host.appendChild(wrap);
  }
}

function renderRoomMarketFeed() {
  const host = $('#room-market-feed'); host.replaceChildren();
  if (!state.roomMarketFeed.length) {
    const empty = document.createElement('p'); empty.className = 'room-market-empty'; empty.textContent = '아직 채팅방 거래가 없습니다.'; host.appendChild(empty); return;
  }
  for (const item of state.roomMarketFeed) {
    const row = document.createElement('div'); row.className = 'room-market-feed-item';
    const person = document.createElement('span'); person.textContent = item.nickname ? `${item.nickname} · ` : '참여자 · ';
    const action = document.createElement('strong'); action.className = item.type === 'buy' ? 'buy' : 'sell'; action.textContent = item.type === 'buy' ? '매수' : '매도';
    const detail = document.createElement('span'); detail.textContent = ` ${item.stockName || item.stockId} ${Number(item.qty) || 0}주 · ${Number(item.price || 0).toLocaleString('ko-KR')}원`;
    row.append(person, action, detail); host.appendChild(row);
  }
}

async function openRoomMarketAddDialog() {
  if (!state.room) return;
  $('#room-market-search').value = '';
  $('#room-market-add-status').hidden = true;
  $('#room-market-search-results').innerHTML = '<p class="room-market-empty">종목 목록을 불러오는 중…</p>';
  openDialog('room-market-add-dialog');
  if (!state.roomMarketStockCatalog.length) {
    try {
      const { db, ref, get } = api();
      const snapshot = await get(ref(db, 'stocksPublic'));
      state.roomMarketStockCatalog = Object.entries(snapshot.val() || {}).map(([id, stock]) => ({ ...(stock || {}), id })).filter((stock) => stock.name && Number.isFinite(Number(stock.price)));
    } catch (error) {
      $('#room-market-search-results').innerHTML = '<p class="room-market-empty">종목 목록을 불러오지 못했습니다.</p>';
      return;
    }
  }
  renderRoomMarketSearchResults();
}

function renderRoomMarketSearchResults() {
  const host = $('#room-market-search-results'); host.replaceChildren();
  const queryText = $('#room-market-search').value.trim().toLocaleLowerCase();
  const existing = new Set(Object.keys(state.roomMarketStocks || {}));
  const entries = state.roomMarketStockCatalog.filter((stock) => !queryText || `${stock.name} ${stock.id}`.toLocaleLowerCase().includes(queryText))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), 'ko')).slice(0, 30);
  if (!entries.length) { const empty = document.createElement('p'); empty.className = 'room-market-empty'; empty.textContent = queryText ? '검색 결과가 없습니다.' : '공유할 종목이 없습니다.'; host.appendChild(empty); return; }
  for (const stock of entries) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'room-market-search-item';
    button.title = `${stock.name} 종목을 채팅방에 공유하기`;
    const identity = document.createElement('span'); const name = document.createElement('strong'); name.textContent = stock.name;
    const id = document.createElement('small'); id.textContent = stock.id; identity.append(name, id);
    const action = document.createElement('span'); action.className = 'price'; action.textContent = existing.has(stock.id) ? '공유 중' : `${Number(stock.price).toLocaleString('ko-KR')}원 · 공유`;
    button.append(identity, action); button.disabled = existing.has(stock.id) || Object.keys(state.roomMarketStocks || {}).length >= 12;
    button.addEventListener('click', async () => {
      button.disabled = true; action.textContent = '공유 중…';
      try {
        await call('messengerRoomMarketUpdate', { roomId: state.room.roomId, stockId: stock.id, action: 'add' });
        action.textContent = '공유 완료';
        showToast(`${stock.name} 종목을 채팅방에 공유했어요.`);
      } catch (error) {
        action.textContent = error.message || '공유 실패'; button.disabled = false;
        $('#room-market-add-status').hidden = false; $('#room-market-add-status').textContent = error.message || '종목을 공유하지 못했습니다.';
      }
    });
    host.appendChild(button);
  }
}

async function openRoomMarketTrade(stockId) {
  if (!state.room || !state.roomMarketStocks[stockId]) return;
  state.roomMarketSelectedStockId = stockId;
  $('#room-market-qty').value = '1'; $('#room-market-show-nickname').checked = false;
  $('#room-market-trade-status').hidden = true;
  $('#room-market-trade-title').textContent = state.roomMarketQuotes[stockId]?.name || state.roomMarketStocks[stockId].name || stockId;
  renderRoomMarketQuote(stockId);
  $('#room-market-chart').textContent = '차트를 불러오는 중…';
  openDialog('room-market-trade-dialog');
  $('#room-market-personal-cash').textContent = '불러오는 중…'; $('#room-market-personal-qty').textContent = '불러오는 중…';
  await Promise.all([loadRoomMarketCandles(stockId), loadRoomMarketPersonalPosition(stockId)]);
}

async function loadRoomMarketPersonalPosition(stockId) {
  const uid = state.session && state.session.uid;
  if (!uid) return;
  try {
    const { db, ref, get } = api();
    const [cashSnap, positionSnap] = await Promise.all([
      get(ref(db, `users/${uid}/cash`)),
      get(ref(db, `users/${uid}/stocks/${stockId}`)),
    ]);
    if (state.roomMarketSelectedStockId !== stockId || !$('#room-market-trade-dialog').open) return;
    $('#room-market-personal-cash').textContent = `${Number(cashSnap.val() || 0).toLocaleString('ko-KR')}원`;
    $('#room-market-personal-qty').textContent = `${Number(positionSnap.val()?.qty || 0).toLocaleString('ko-KR')}주`;
  } catch (_) {
    $('#room-market-personal-cash').textContent = '확인 불가'; $('#room-market-personal-qty').textContent = '확인 불가';
  }
}

function renderRoomMarketQuote(stockId) {
  const stock = state.roomMarketQuotes[stockId];
  if (!stock) { $('#room-market-live-price').textContent = '—'; $('#room-market-live-change').textContent = '현재가 정보 없음'; return; }
  $('#room-market-trade-title').textContent = stock.name || state.roomMarketStocks[stockId]?.name || stockId;
  $('#room-market-live-price').textContent = Number(stock.price || 0).toLocaleString('ko-KR') + '원';
  $('#room-market-live-change').textContent = '실시간 현재가';
}

function renderRoomMarketChart(stockId) {
  const host = $('#room-market-chart');
  if (state.roomMarketSelectedStockId !== stockId || !host) return;
  const values = (state.roomMarketCandles || []).map((candle) => Number(candle.c)).filter((value) => Number.isFinite(value) && value > 0);
  const current = Number(state.roomMarketQuotes[stockId]?.price);
  if (Number.isFinite(current) && current > 0 && values[values.length - 1] !== current) values.push(current);
  if (!values.length) { host.textContent = '아직 표시할 주가 기록이 없습니다.'; return; }
  const points = values.slice(-90); const width = 600; const height = 150; const padding = 14;
  const min = Math.min(...points); const max = Math.max(...points); const span = Math.max(max - min, Math.abs(max) * 0.002, 1);
  const coords = points.map((value, index) => `${padding + index * (width - padding * 2) / Math.max(points.length - 1, 1)},${height - padding - (value - min) / span * (height - padding * 2)}`);
  const ns = 'http://www.w3.org/2000/svg'; const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', `0 0 ${width} ${height}`); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', '최근 분봉 종가와 현재가');
  for (let i = 1; i <= 3; i += 1) { const line = document.createElementNS(ns, 'line'); const y = padding + i * (height - padding * 2) / 4; line.setAttribute('x1', String(padding)); line.setAttribute('x2', String(width - padding)); line.setAttribute('y1', String(y)); line.setAttribute('y2', String(y)); line.setAttribute('stroke', '#e8edf7'); line.setAttribute('stroke-width', '1'); svg.appendChild(line); }
  const path = document.createElementNS(ns, 'polyline'); path.setAttribute('points', coords.join(' ')); path.setAttribute('fill', 'none'); path.setAttribute('stroke', points[points.length - 1] >= points[0] ? '#5878ed' : '#d86c76'); path.setAttribute('stroke-width', '3'); path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round'); svg.appendChild(path);
  host.replaceChildren(svg);
}

async function loadRoomMarketCandles(stockId) {
  try {
    const { db, ref, get } = api();
    const snapshot = await get(ref(db, `candlesticks/${stockId}`));
    if (state.roomMarketSelectedStockId !== stockId || !$('#room-market-trade-dialog').open) return;
    state.roomMarketCandles = Object.values(snapshot.val() || {}).filter((candle) => candle && Number.isFinite(Number(candle.t)) && Number.isFinite(Number(candle.c))).sort((a, b) => Number(a.t) - Number(b.t));
    renderRoomMarketChart(stockId);
  } catch (error) {
    state.roomMarketCandles = [];
    renderRoomMarketChart(stockId);
  }
}

async function executeRoomMarketTrade(type) {
  if (!state.room || !state.roomMarketSelectedStockId || state.roomMarketTrading) return;
  const qty = Number($('#room-market-qty').value);
  if (!Number.isInteger(qty) || qty < 1 || qty > 10) { $('#room-market-trade-status').hidden = false; $('#room-market-trade-status').textContent = '수량은 1주부터 10주까지 입력해 주세요.'; return; }
  state.roomMarketTrading = true;
  const buttons = [$('#room-market-buy'), $('#room-market-sell')]; buttons.forEach((button) => { button.disabled = true; });
  $('#room-market-trade-status').hidden = false; $('#room-market-trade-status').textContent = '거래를 처리하고 있습니다…';
  const stockId = state.roomMarketSelectedStockId; const roomId = state.room.roomId;
  try {
    const result = await call('trade', { stockId, type, qty, messengerRoomId: roomId, showNickname: $('#room-market-show-nickname').checked });
    call('triggerBotReaction', { stockId, type }).catch(() => {});
    $('#room-market-trade-status').textContent = `${type === 'buy' ? '매수' : '매도'} 체결 · ${qty}주 · 체결가 ${Number(result.price || 0).toLocaleString('ko-KR')}원`;
    $('#room-market-personal-cash').textContent = `${Number(result.cash || 0).toLocaleString('ko-KR')}원`;
    $('#room-market-personal-qty').textContent = `${Number(result.position?.qty || 0).toLocaleString('ko-KR')}주`;
    state.roomMarketLastTradeAt = Date.now();
    setTimeout(() => { state.roomMarketTrading = false; buttons.forEach((button) => { button.disabled = false; }); }, 1100);
  } catch (error) {
    $('#room-market-trade-status').textContent = error.message || '거래를 처리하지 못했습니다.';
    state.roomMarketTrading = false; buttons.forEach((button) => { button.disabled = false; });
  }
}

function combineMessages(...groups) {
  const byId = new Map();
  for (const group of groups) for (const message of group || []) if (message && message.id) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0) || String(a.id).localeCompare(String(b.id)));
}

function discardAcknowledgedOptimisticMessages(liveMessages) {
  const liveIds = new Set((liveMessages || []).map((message) => message.id));
  state.optimisticMessages = state.optimisticMessages.filter((message) => !liveIds.has(message.id));
}

async function loadOlderMessages() {
  if (!state.room || state.loadingOlderMessages || !state.hasOlderMessages) return;
  const roomId = state.room.roomId;
  const owner = state.isOwner;
  const uid = state.session.uid;
  const { db, ref, get, query, orderByKey, endBefore, limitToLast } = api();
  const pageLimit = MESSAGE_PAGE_SIZE + 1;
  state.loadingOlderMessages = true;
  renderTimeline({ preservePosition: true });
  try {
    if (owner) {
      const loaded = state.olderMessages;
      const cursor = loaded.length ? loaded[0].id : (state.liveMessages[0] && state.liveMessages[0].id);
      if (!cursor) { state.hasOlderMessages = false; state.olderMessagesExhausted = true; return; }
      const path = `streamerMessenger/chat/${roomId}/streamerTimeline`;
      const snapshot = await get(query(ref(db, path), orderByKey(), endBefore(cursor), limitToLast(pageLimit)));
      if (!state.room || state.room.roomId !== roomId || state.isOwner !== owner) return;
      const page = Object.values(snapshot.val() || {});
      state.hasOlderMessages = page.length > MESSAGE_PAGE_SIZE;
      state.olderMessagesExhausted = !state.hasOlderMessages;
      state.olderMessages = combineMessages(state.olderMessages, page.slice(-MESSAGE_PAGE_SIZE));
      state.messages = combineMessages(state.olderMessages, state.liveMessages, state.optimisticMessages);
    } else {
      const streams = [
        { path: `streamerMessenger/chat/${roomId}/private/${uid}`, older: state.olderPrivateMessages, live: state.privateMessages || [], key: 'private' },
        { path: `streamerMessenger/chat/${roomId}/broadcast`, older: state.olderBroadcastMessages, live: state.broadcastMessages || [], key: 'broadcast' },
      ];
      const pages = await Promise.all(streams.map(async (stream) => {
        const cursor = stream.older.length ? stream.older[0].id : (stream.live[0] && stream.live[0].id);
        if (!cursor) return { key: stream.key, page: [], hasMore: false };
        const snapshot = await get(query(ref(db, stream.path), orderByKey(), endBefore(cursor), limitToLast(pageLimit)));
        const values = Object.values(snapshot.val() || {});
        return { key: stream.key, page: values.slice(-MESSAGE_PAGE_SIZE), hasMore: values.length > MESSAGE_PAGE_SIZE };
      }));
      if (!state.room || state.room.roomId !== roomId || state.isOwner !== owner || state.session.uid !== uid) return;
      for (const result of pages) {
        if (result.key === 'private') {
          state.olderPrivateMessages = combineMessages(state.olderPrivateMessages, result.page);
          state.hasOlderPrivateMessages = result.hasMore;
          state.olderPrivateMessagesExhausted = !result.hasMore;
        } else {
          state.olderBroadcastMessages = combineMessages(state.olderBroadcastMessages, result.page);
          state.hasOlderBroadcastMessages = result.hasMore;
          state.olderBroadcastMessagesExhausted = !result.hasMore;
        }
      }
      state.hasOlderMessages = state.hasOlderPrivateMessages || state.hasOlderBroadcastMessages;
      state.messages = combineMessages(state.olderPrivateMessages, state.olderBroadcastMessages, state.privateMessages, state.broadcastMessages, state.optimisticMessages);
    }
  } catch (error) {
    if (state.room && state.room.roomId === roomId) {
      console.error('이전 대화를 불러오지 못했습니다.', error);
      showToast('이전 대화를 불러오지 못했어요. 다시 시도해 주세요.');
    }
  } finally {
    if (state.room && state.room.roomId === roomId && state.isOwner === owner) {
      state.loadingOlderMessages = false;
      renderTimeline({ preservePosition: true });
    }
  }
}

function trackNotifications(messages) {
  const fullyLoaded = state.isOwner ? state.timelineLoaded.owner : state.timelineLoaded.private && state.timelineLoaded.broadcast;
  if (!state.notificationsPrimed && fullyLoaded) {
    messages.forEach((m) => state.seenMessageIds.add(m.id));
    state.notificationsPrimed = true;
    return;
  }
  if (!state.notificationsPrimed) return;
  if (!state.seenMessageIds.size) { messages.forEach((m) => state.seenMessageIds.add(m.id)); return; }
  for (const message of messages) {
    if (!state.seenMessageIds.has(message.id)) showNewMessageNotification(message);
    state.seenMessageIds.add(message.id);
  }
}

async function getImageUrl(imageId) {
  if (state.imageUrls.has(imageId)) return state.imageUrls.get(imageId);
  const promise = call('messengerGetGalleryImage', { roomId: state.room.roomId, imageId }).then((image) => image.thumbUrl || image.imageUrl).catch(() => '');
  state.imageUrls.set(imageId, promise);
  return promise;
}

async function getRoomselfImageUrl(message) {
  const imageId = message.roomselfImageId;
  if (state.roomselfUrls.has(imageId)) return state.roomselfUrls.get(imageId);
  const promise = call('messengerGetRoomselfImage', { roomId: state.room.roomId, imageId }).then((result) => {
    return roomselfDataUrl(result);
  }).catch(() => '');
  state.roomselfUrls.set(imageId, promise);
  return promise;
}

function roomselfDataUrl(result) {
  const binary = atob(result.data); const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: result.contentType }));
}

function renderPinnedMessage() {
  const host = $('#pinned-message-panel');
  const pointer = state.pinnedMessagePointer;
  if (!state.room || !pointer) { host.hidden = true; host.replaceChildren(); return; }
  host.hidden = false;
  host.replaceChildren();
  const actionable = state.isOwner;
  const card = document.createElement(actionable ? 'button' : 'article');
  card.className = `pinned-message-card${actionable ? ' actionable' : ''}`;
  if (actionable) {
    card.type = 'button';
    card.setAttribute('aria-label', state.pinActionPending ? '고정 메시지 처리 중' : '고정된 메시지를 눌러 채팅방 상단에서 내리기');
    card.title = state.pinActionPending ? '고정 메시지를 처리하고 있어요.' : '고정된 메시지를 눌러 채팅방 상단에서 내려요.';
    card.disabled = state.pinActionPending;
    card.addEventListener('click', () => setPinnedMessage(''));
  } else card.setAttribute('role', 'note');

  const badge = document.createElement('span'); badge.className = 'pinned-message-badge'; badge.textContent = '📌 고정 메시지';
  const copy = document.createElement('span'); copy.className = 'pinned-message-copy';
  const sender = document.createElement('strong'); sender.className = 'pinned-message-sender';
  const details = state.pinnedMessageDetails;
  sender.textContent = details && details.senderName || (details && details.senderRole === 'fan' ? '팬' : '스트리머');
  const preview = document.createElement('span'); preview.className = 'pinned-message-preview';
  if (state.pinnedMessageLoading) preview.textContent = '고정 메시지를 불러오는 중…';
  else if (!details) preview.textContent = '고정 메시지를 불러올 수 없습니다.';
  else if (details.kind === 'image') preview.textContent = '갤러리 이미지';
  else preview.textContent = details.text || '메시지 내용이 없습니다.';
  copy.append(sender, preview);
  card.append(badge, copy);
  if (details && details.kind === 'image' && details.galleryImageId) {
    const image = document.createElement('img'); image.className = 'pinned-message-image'; image.alt = '고정된 갤러리 이미지'; image.loading = 'lazy';
    getImageUrl(details.galleryImageId).then((url) => { if (url && card.isConnected && state.pinnedMessagePointer?.messageId === pointer.messageId) image.src = url; });
    card.appendChild(image);
  }
  host.appendChild(card);
}

async function setPinnedMessage(messageId) {
  if (!state.room || !state.isOwner || state.pinActionPending) return;
  const room = state.room;
  state.pinActionPending = true;
  renderPinnedMessage();
  renderTimeline({ preservePosition: true });
  try {
    await call('messengerSetPinnedMessage', { roomId: room.roomId, messageId });
    if (state.room && state.room.roomId === room.roomId) showToast(messageId ? '메시지를 채팅방 상단에 고정했어요.' : '고정 메시지를 내렸어요.');
  } catch (error) {
    if (state.room && state.room.roomId === room.roomId) showError(error);
  } finally {
    if (state.room && state.room.roomId === room.roomId) {
      state.pinActionPending = false;
      renderPinnedMessage();
      renderTimeline({ preservePosition: true });
    }
  }
}

function renderTimeline({ preservePosition = false } = {}) {
  const host = $('#timeline');
  if (linkPreviewObserver) linkPreviewObserver.disconnect();
  const oldHeight = host.scrollHeight;
  const oldTop = host.scrollTop;
  const wasAtBottom = oldHeight - oldTop - host.clientHeight < 56;
  host.replaceChildren();
  const historyReady = state.isOwner ? state.timelineLoaded && state.timelineLoaded.owner : state.timelineLoaded && state.timelineLoaded.private && state.timelineLoaded.broadcast;
  if (historyReady) {
    const status = document.createElement('div');
    status.className = 'timeline-history-status';
    status.textContent = state.loadingOlderMessages ? '이전 대화를 불러오는 중…' : state.hasOlderMessages ? '위로 스크롤해 이전 대화를 불러오세요' : '오래된 대화가 없습니다.';
    host.appendChild(status);
  }
  let messages = state.messages || [];
  if (state.isOwner && state.selectedFanUid) messages = messages.filter((m) => !m.recipientUid || m.recipientUid === state.selectedFanUid || m.senderUid === state.selectedFanUid);
  messages = [...messages].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  if (!messages.length) { const empty = document.createElement('div'); empty.className = 'timeline-empty'; empty.textContent = '대화가 시작되면 여기에 표시됩니다.'; host.appendChild(empty); }
  else for (const message of messages) host.appendChild(renderMessage(message));
  if (preservePosition) host.scrollTop = oldTop + (host.scrollHeight - oldHeight);
  else if (wasAtBottom) host.scrollTop = host.scrollHeight;
}

function localDateTimeValue(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function openReportDialog() {
  if (!state.room || !state.session || !state.session.trusted) return;
  if (state.isOwner && (!state.selectedFanUid || !state.fans.some((fan) => fan.uid === state.selectedFanUid && fan.status === 'active'))) {
    showError({ message: '신고할 팬 대화를 먼저 선택해 주세요.' }); return;
  }
  const now = new Date();
  const startInput = $('#report-start'); const endInput = $('#report-end');
  startInput.min = localDateTimeValue(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000));
  startInput.max = localDateTimeValue(now); endInput.min = startInput.min; endInput.max = startInput.max;
  endInput.value = localDateTimeValue(now);
  startInput.value = localDateTimeValue(new Date(now.getTime() - 60 * 60 * 1000));
  $('#report-reason-category').value = ''; $('#report-reason').value = ''; $('#report-submit-error').hidden = true;
  openDialog('report-submit-dialog');
}

async function submitReport() {
  const error = $('#report-submit-error'); error.hidden = true;
  const startAt = new Date($('#report-start').value).getTime();
  const endAt = new Date($('#report-end').value).getTime();
  const now = Date.now(); const reasonCategory = $('#report-reason-category').value; const reason = $('#report-reason').value.trim();
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || startAt >= endAt) { error.textContent = '시작·종료 시간을 확인해 주세요.'; error.hidden = false; return; }
  if (startAt < now - 7 * 24 * 60 * 60 * 1000 || endAt > now) { error.textContent = '최근 7일 안의 시간 범위를 선택해 주세요.'; error.hidden = false; return; }
  if (endAt - startAt > 24 * 60 * 60 * 1000) { error.textContent = '신고 범위는 최대 24시간까지 선택할 수 있습니다.'; error.hidden = false; return; }
  if (!reasonCategory) { error.textContent = '신고 사유를 선택해 주세요.'; error.hidden = false; return; }
  const submit = $('#submit-report'); submit.disabled = true;
  try {
    const reportData = { roomId: state.room.roomId, startAt, endAt, reasonCategory, reason };
    if (state.isOwner) reportData.targetUid = state.selectedFanUid;
    await call('messengerSubmitReport', reportData);
    closeDialog('report-submit-dialog'); showError({ message: '관리자에게 신고를 접수했습니다.' });
  } catch (cause) { error.textContent = cause.message || '신고를 접수하지 못했습니다.'; error.hidden = false; }
  finally { submit.disabled = false; }
}

function openExportDialog() {
  if (!state.room || !state.session || !state.session.trusted) return;
  if (state.isOwner && state.selectedFanUid && !state.fans.some((fan) => fan.uid === state.selectedFanUid && fan.status === 'active')) {
    showError({ message: '현재 대화를 저장할 수 없습니다.' }); return;
  }
  const now = new Date();
  $('#export-end').value = localDateTimeValue(now);
  $('#export-start').value = localDateTimeValue(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  $('#export-error').hidden = true;
  openDialog('export-dialog');
}

async function getExportMessages() {
  const errorEl = $('#export-error');
  errorEl.hidden = true;
  const start = new Date($('#export-start').value).getTime();
  const end = new Date($('#export-end').value).getTime();
  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error('시작 시간과 종료 시간을 확인해 주세요.');
  if (start < sevenDaysAgo || end > now) throw new Error('최근 7일 안의 시간 범위만 저장할 수 있습니다.');
  const { db, ref, get, query, orderByChild, startAt, endAt, limitToFirst } = api();
  const roomId = state.room.roomId;
  const readRange = async (path) => {
    const rangeQuery = query(ref(db, path), orderByChild('createdAt'), startAt(start), endAt(end), limitToFirst(501));
    const snapshot = await get(rangeQuery);
    const values = snapshot.val() || {};
    return Object.entries(values).map(([key, message]) => ({ ...message, id: message.id || key }));
  };
  let messages;
  if (state.isOwner) {
    messages = await readRange(`streamerMessenger/chat/${roomId}/streamerTimeline`);
    if (state.selectedFanUid) messages = messages.filter((message) => !message.recipientUid || message.recipientUid === state.selectedFanUid || message.senderUid === state.selectedFanUid);
  } else {
    messages = (await Promise.all([
      readRange(`streamerMessenger/chat/${roomId}/private/${state.session.uid}`),
      readRange(`streamerMessenger/chat/${roomId}/broadcast`),
    ])).flat().filter((message, index, all) => all.findIndex((item) => item.id === message.id) === index);
  }
  if (messages.length > 500) throw new Error('한 번에 최대 500개 메시지만 저장할 수 있습니다. 범위를 좁혀 다시 저장해 주세요.');
  messages.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
  const imageMessages = messages.filter((message) => message.kind === 'image');
  const accessibleImages = new Set();
  const imageIds = [...new Set(imageMessages.map((message) => message.galleryImageId).filter(Boolean))];
  for (let i = 0; i < imageIds.length; i += 8) {
    const checks = await Promise.all(imageIds.slice(i, i + 8).map(async (imageId) => {
      try { await call('messengerGetGalleryImage', { roomId, imageId }); return imageId; }
      catch (_) { return ''; }
    }));
    checks.filter(Boolean).forEach((imageId) => accessibleImages.add(imageId));
  }
  const visible = messages.filter((message) => message.kind !== 'image' || accessibleImages.has(message.galleryImageId));
  return { messages: visible, unavailableImages: imageMessages.length - visible.filter((message) => message.kind === 'image').length };
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = filename;
  document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportFilename(extension) {
  const label = state.isOwner && state.selectedFanUid
    ? (state.fans.find((fan) => fan.uid === state.selectedFanUid)?.profile?.nickname || '팬 대화')
    : (state.room.streamerNickname || '메신저');
  const safe = label.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 40) || '메신저';
  return `${safe}-대화-${new Date().toISOString().slice(0, 10)}.${extension}`;
}

function messageExportText(messages, unavailableImages) {
  const start = new Date($('#export-start').value).toLocaleString('ko-KR');
  const end = new Date($('#export-end').value).toLocaleString('ko-KR');
  const lines = [`${state.room.streamerNickname || '스트리머'} 메신저 대화`, `${start} – ${end}`, ...(unavailableImages ? [`접근할 수 없는 갤러리 이미지 ${unavailableImages}개 제외`] : []), ''];
  for (const message of messages) {
    const time = new Date(Number(message.createdAt || 0)).toLocaleString('ko-KR');
    const body = message.kind === 'image' ? '[갤러리 이미지 첨부]' : message.kind === 'roomself' ? '[비공개 방셀 이미지]' : (message.text || '');
    lines.push(`[${time}] ${message.senderName || (message.senderRole === 'streamer' ? '스트리머' : '팬')}: ${body}`);
  }
  return lines.join('\n');
}

function wrapCanvasText(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of String(text || '').split('\n')) {
    let line = '';
    for (const char of paragraph) {
      if (line && ctx.measureText(line + char).width > maxWidth) { lines.push(line); line = char; }
      else line += char;
    }
    lines.push(line);
  }
  return lines.length ? lines : [''];
}

function conversationCanvas(messages, unavailableImages = 0) {
  const width = 1200; const margin = 64; const contentWidth = width - margin * 2;
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = '24px "Noto Sans KR", sans-serif';
  const layouts = messages.map((message) => {
    const body = message.kind === 'image' ? '[갤러리 이미지 첨부]' : message.kind === 'roomself' ? '[비공개 방셀 이미지]' : (message.text || '');
    const lines = wrapCanvasText(ctx, body, contentWidth - 48);
    return { message, lines, height: 76 + lines.length * 36 };
  });
  const height = 250 + layouts.reduce((sum, item) => sum + item.height + 16, 0);
  if (height > 24000) throw new Error('대화 이미지가 너무 길어요. 더 짧은 시간 범위를 선택해 주세요.');
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const draw = canvas.getContext('2d');
  draw.fillStyle = '#f5f8ff'; draw.fillRect(0, 0, width, height);
  draw.fillStyle = '#263451'; draw.font = 'bold 34px "Noto Sans KR", sans-serif';
  draw.fillText(`${state.room.streamerNickname || '스트리머'} 메신저 대화`, margin, 72);
  draw.fillStyle = '#77849b'; draw.font = '18px "Noto Sans KR", sans-serif';
  draw.fillText(`${new Date($('#export-start').value).toLocaleString('ko-KR')} – ${new Date($('#export-end').value).toLocaleString('ko-KR')}`, margin, 108);
  if (unavailableImages) draw.fillText(`접근할 수 없는 갤러리 이미지 ${unavailableImages}개 제외`, margin, 137);
  let y = unavailableImages ? 177 : 148;
  for (const item of layouts) {
    const message = item.message;
    draw.fillStyle = '#8793a8'; draw.font = '16px "Noto Sans KR", sans-serif';
    draw.fillText(`${message.senderName || (message.senderRole === 'streamer' ? '스트리머' : '팬')} · ${new Date(Number(message.createdAt || 0)).toLocaleString('ko-KR')}`, margin, y + 22);
    draw.fillStyle = message.senderRole === 'streamer' ? '#e6f5ef' : '#ffffff';
    draw.beginPath(); draw.roundRect(margin, y + 34, contentWidth, item.height - 38, 18); draw.fill();
    draw.fillStyle = '#263451'; draw.font = '24px "Noto Sans KR", sans-serif';
    item.lines.forEach((line, index) => draw.fillText(line, margin + 24, y + 78 + index * 36));
    y += item.height + 16;
  }
  return canvas;
}

async function exportConversation(format) {
  const buttons = [$('#export-text'), $('#export-image')];
  buttons.forEach((button) => { button.disabled = true; });
  $('#export-error').hidden = true;
  try {
    const { messages, unavailableImages } = await getExportMessages();
    if (format === 'image') {
      if (messages.length > 100) throw new Error('대화 이미지는 최대 100개 메시지까지 저장할 수 있습니다. 범위를 좁혀 주세요.');
      const canvas = conversationCanvas(messages, unavailableImages);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('대화 이미지를 만들지 못했습니다.');
      downloadBlob(blob, exportFilename('png'));
    } else {
      const blob = new Blob(['\ufeff', messageExportText(messages, unavailableImages)], { type: 'text/plain;charset=utf-8' });
      downloadBlob(blob, exportFilename('txt'));
    }
    closeDialog('export-dialog');
  } catch (error) {
    const errorEl = $('#export-error'); errorEl.textContent = error.message || '대화를 저장하지 못했습니다.'; errorEl.hidden = false;
  } finally { buttons.forEach((button) => { button.disabled = false; }); }
}

function youtubeVideoId(href) {
  try {
    const url = new URL(href); const host = url.hostname.toLowerCase().replace(/^www\./, '');
    let id = '';
    if (host === 'youtu.be') id = url.pathname.split('/').filter(Boolean)[0] || '';
    else if (['youtube.com', 'm.youtube.com', 'youtube-nocookie.com'].includes(host)) {
      if (url.pathname === '/watch') id = url.searchParams.get('v') || '';
      else id = url.pathname.match(/^\/(?:shorts|embed|live)\/([^/?]+)/)?.[1] || '';
    }
    return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : '';
  } catch (_) { return ''; }
}

function isDirectVideoUrl(href) {
  try { return new URL(href).protocol === 'https:' && /\.(?:mp4|m4v|webm|ogv|mov)$/i.test(new URL(href).pathname); }
  catch (_) { return false; }
}

function youtubePreview(videoId) {
  const card = document.createElement('div'); card.className = 'message-video-preview youtube-video-preview';
  const image = document.createElement('img'); image.src = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`; image.alt = 'YouTube 동영상 미리보기'; image.loading = 'lazy';
  const play = document.createElement('button'); play.className = 'video-play-button'; play.type = 'button'; play.textContent = '▶'; play.title = '채팅방에서 YouTube 영상 재생'; play.setAttribute('aria-label', '채팅방에서 YouTube 영상 재생');
  play.addEventListener('click', () => {
    const frame = document.createElement('iframe'); frame.src = `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&playsinline=1&rel=0`; frame.title = 'YouTube 영상'; frame.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'; frame.allowFullscreen = true; frame.referrerPolicy = 'strict-origin-when-cross-origin';
    card.replaceChildren(frame);
  }, { once: true });
  card.append(image, play); return card;
}

function directVideoPreview(href) {
  const card = document.createElement('div'); card.className = 'message-video-preview';
  const video = document.createElement('video'); video.src = href; video.controls = true; video.playsInline = true; video.preload = 'none'; video.title = '채팅방에서 영상 재생';
  card.appendChild(video); return card;
}

function previewCacheKey(roomId, href) { return `${roomId}\n${href}`; }

function loadLinkPreview(card, href, roomId) {
  const key = previewCacheKey(roomId, href);
  let pending = state.linkPreviewCache.get(key);
  if (!pending) {
    pending = call('messengerGetLinkPreview', { roomId, url: href });
    state.linkPreviewCache.set(key, pending);
    pending.catch(() => { if (state.linkPreviewCache.get(key) === pending) state.linkPreviewCache.delete(key); });
    while (state.linkPreviewCache.size > 40) state.linkPreviewCache.delete(state.linkPreviewCache.keys().next().value);
  }
  pending.then((preview) => {
    if (!card.isConnected) return;
    card.replaceChildren();
    if (preview.image && preview.image.contentType && preview.image.data) {
      const image = document.createElement('img'); image.className = 'message-link-preview-image'; image.src = `data:${preview.image.contentType};base64,${preview.image.data}`; image.alt = ''; image.loading = 'lazy'; card.appendChild(image);
    }
    const text = document.createElement('span'); text.className = 'message-link-preview-copy';
    const title = document.createElement('strong'); title.textContent = preview.title || new URL(href).hostname; text.appendChild(title);
    if (preview.description) { const description = document.createElement('small'); description.textContent = preview.description; text.appendChild(description); }
    const domain = document.createElement('small'); domain.className = 'message-link-preview-domain';
    try { domain.textContent = new URL(preview.url || href).hostname; } catch (_) { domain.textContent = ''; }
    text.appendChild(domain); card.appendChild(text);
  }).catch(() => { if (card.isConnected) card.remove(); });
}

let linkPreviewObserver = null;
function observeLinkPreview(card, href, roomId) {
  if ('IntersectionObserver' in window) {
    if (!linkPreviewObserver) linkPreviewObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) {
        const target = entry.target; linkPreviewObserver.unobserve(target);
        loadLinkPreview(target, target.dataset.previewUrl, target.dataset.previewRoom);
      }
    }, { root: $('#timeline'), rootMargin: '220px 0px' });
    card.dataset.previewUrl = href; card.dataset.previewRoom = roomId; linkPreviewObserver.observe(card);
  } else loadLinkPreview(card, href, roomId);
}

function renderTextWithLinks(message, bubble) {
  const value = String(message.text || '');
  const matcher = /https?:\/\/[^\s<>"']+/gi;
  let cursor = 0; let match; let mediaPreviewAdded = false; let genericPreviewAdded = false; const previewUrls = [];
  while ((match = matcher.exec(value))) {
    const raw = match[0]; let href = raw;
    let trailing = '';
    while (/[.,!?;:，。！？；：]$/.test(href)) { trailing = href.slice(-1) + trailing; href = href.slice(0, -1); }
    let parsed;
    try { parsed = new URL(href); } catch (_) { parsed = null; }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) continue;
    bubble.appendChild(document.createTextNode(value.slice(cursor, match.index)));
    const link = document.createElement('a'); link.className = 'message-inline-link'; link.href = parsed.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = href; link.title = '링크를 새 탭에서 열기'; link.setAttribute('aria-label', `링크 열기: ${parsed.hostname}`); bubble.appendChild(link);
    if (trailing) bubble.appendChild(document.createTextNode(trailing));
    const videoId = youtubeVideoId(parsed.href);
    if (!mediaPreviewAdded && videoId) { bubble.appendChild(youtubePreview(videoId)); mediaPreviewAdded = true; }
    else if (!mediaPreviewAdded && isDirectVideoUrl(parsed.href)) { bubble.appendChild(directVideoPreview(parsed.href)); mediaPreviewAdded = true; }
    else if (!genericPreviewAdded && parsed.protocol === 'https:' && !videoId && !isDirectVideoUrl(parsed.href)) { previewUrls.push(parsed.href); genericPreviewAdded = true; }
    cursor = match.index + raw.length;
  }
  bubble.appendChild(document.createTextNode(value.slice(cursor)));
  if (previewUrls.length && state.room) {
    const card = document.createElement('a'); card.className = 'message-link-preview'; card.href = previewUrls[0]; card.target = '_blank'; card.rel = 'noopener noreferrer'; card.title = '링크 미리보기 열기'; card.setAttribute('aria-label', '링크 미리보기를 새 탭에서 열기');
    const loading = document.createElement('span'); loading.className = 'message-link-preview-loading'; loading.textContent = '링크 미리보기를 불러오는 중…'; card.appendChild(loading);
    bubble.appendChild(card); observeLinkPreview(card, previewUrls[0], state.room.roomId);
  }
}

function renderMessage(message) {
  const isMine = message.senderUid === state.session.uid;
  const isStreamerMessage = message.senderRole === 'streamer';
  const row = document.createElement('article'); row.className = `message-row ${isStreamerMessage ? 'streamer' : 'fan-message'}${isMine ? ' own' : ''}`;
  const senderProfile = isStreamerMessage
    ? { soopId: state.room.streamerSoopId }
    : (isMine ? (state.session.profile || {}) : (state.fans.find((fan) => fan.uid === message.senderUid) || {}).profile || {});
  const profileLink = stationUrl(senderProfile.soopId);
  const avatar = document.createElement(profileLink ? 'a' : 'div'); avatar.className = 'message-avatar';
  if (profileLink) { avatar.href = profileLink; avatar.target = '_blank'; avatar.rel = 'noopener noreferrer'; avatar.setAttribute('aria-label', `${message.senderName || '사용자'} SOOP 방송국을 새 탭에서 열기`); avatar.title = 'SOOP 방송국 열기'; }
  if (message.senderAvatarUrl) { const img = document.createElement('img'); img.src = message.senderAvatarUrl; img.alt = ''; avatar.appendChild(img); }
  else avatar.textContent = (message.senderName || '✦').slice(0, 1);
  const stack = document.createElement('div'); stack.className = 'message-stack';
  if (!isMine) { const name = document.createElement('p'); name.className = 'message-name'; name.textContent = message.senderName || (isStreamerMessage ? '스트리머' : '팬'); stack.appendChild(name); }
  const bubble = document.createElement('div'); bubble.className = 'message-bubble';
  if (message.kind === 'image') {
    const img = document.createElement('img'); img.className = 'message-image'; img.alt = '스트리머 갤러리 이미지'; img.loading = 'lazy'; img.src = '';
    getImageUrl(message.galleryImageId).then((url) => { if (url) img.src = url; else { const unavailable = document.createElement('span'); unavailable.textContent = '갤러리 이미지에 접근할 수 없어요.'; bubble.replaceChildren(unavailable); } });
    bubble.appendChild(img);
  } else if (message.kind === 'roomself') {
    if (message.pending) bubble.textContent = '비공개 이미지 전송 중…';
    else {
      const img = document.createElement('img'); img.className = 'message-image'; img.alt = '비공개 방셀 이미지'; img.loading = 'lazy';
      getRoomselfImageUrl(message).then((url) => { if (url) img.src = url; else { const unavailable = document.createElement('span'); unavailable.textContent = '비공개 이미지를 불러오지 못했어요.'; bubble.replaceChildren(unavailable); } });
      bubble.appendChild(img);
    }
  } else renderTextWithLinks(message, bubble);
  stack.appendChild(bubble);
  const meta = document.createElement('div'); meta.className = 'message-meta';
  const time = document.createElement('span'); time.textContent = new Date(message.createdAt || Date.now()).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }); meta.appendChild(time);
  if (state.isOwner && message.senderRole === 'streamer' && message.recipientUid) {
    const recipient = state.fans.find((fan) => fan.uid === message.recipientUid);
    const recipientName = message.recipientName || recipient && recipient.profile && recipient.profile.nickname || (message.recipientUid === state.session.uid && state.session.profile && state.session.profile.nickname) || '팬';
    const label = document.createElement('span'); label.className = 'message-kind'; label.textContent = `${recipientName}에게 보냄`; meta.appendChild(label);
  }
  if (state.isOwner && message.senderRole === 'fan') {
    const reply = document.createElement('button'); reply.className = 'reply-action'; reply.type = 'button'; reply.textContent = '답변';
    reply.title = `${message.senderName || '팬'}에게 비공개 답변 보내기`;
    reply.addEventListener('click', () => setReply(message)); meta.appendChild(reply);
  }
  const canPinMessage = state.isOwner && ['streamer', 'fan'].includes(message.senderRole)
    && (message.senderRole === 'fan' || !message.recipientUid)
    && ['text', 'image'].includes(message.kind) && !message.pending && !!message.id;
  if (canPinMessage) {
    const pinned = state.pinnedMessagePointer && state.pinnedMessagePointer.messageId === message.id;
    const pin = document.createElement('button'); pin.className = `pin-message-action${pinned ? ' is-pinned' : ''}`; pin.type = 'button';
    pin.textContent = pinned ? '고정됨' : message.senderRole === 'fan' ? '모두에게 고정' : '고정';
    pin.title = pinned
      ? '상단에 고정된 메시지입니다. 위의 고정 메시지를 눌러 해제하세요.'
      : message.senderRole === 'fan'
        ? '고정하면 이 팬 메시지가 채팅방 참여자 모두에게 공개됩니다.'
        : '이 공개 메시지를 채팅방 상단에 고정해 모두에게 보여줘요.';
    pin.setAttribute('aria-label', pin.title);
    pin.disabled = !!state.pinActionPending || !!pinned;
    pin.addEventListener('click', () => setPinnedMessage(message.id));
    meta.appendChild(pin);
  }
  if (message.pending) { const pending = document.createElement('span'); pending.className = 'message-delivery-status'; pending.textContent = '전송 중'; meta.appendChild(pending); }
  stack.appendChild(meta);
  row.append(avatar, stack);
  return row;
}

async function loadStreamerLists() {
  const roomId = state.room.roomId;
  try {
    const [fansResult, requestsResult] = await Promise.all([
      call('messengerListFans', { roomId }), call('messengerListApplications', { roomId }),
    ]);
    if (!state.room || state.room.roomId !== roomId || !state.isOwner) return;
    state.fans = fansResult.fans || []; state.blockedFans = state.fans.filter((fan) => fan.status === 'blocked'); state.applications = requestsResult.applications || [];
    const currentApplicationUids = new Set(state.applications.map((application) => application.uid));
    state.knownApplicationUids = currentApplicationUids;
    renderFans(); renderBlockedFans(); renderApplications(); updateRecipientSelect();
  } catch (error) { showError(error); }
}

function renderFans() {
  const host = $('#fan-list'); host.replaceChildren();
  const activeFans = state.fans.filter((fan) => fan.status === 'active');
  if (!activeFans.length) { host.textContent = '아직 승인된 팬이 없습니다.'; host.className = 'fan-list muted'; return; }
  host.className = 'fan-list';
  const all = document.createElement('button'); all.className = `fan-item${state.selectedFanUid ? '' : ' active'}`; all.type = 'button'; all.textContent = '모든 팬 대화';
  all.title = '모든 팬과의 대화를 함께 표시하기';
  all.addEventListener('click', () => { state.selectedFanUid = ''; renderFans(); renderTimeline(); }); host.appendChild(all);
  const keyword = state.fanSearchQuery.trim().toLocaleLowerCase();
  const visibleFans = keyword ? activeFans.filter((fan) => {
    const profile = fan.profile || {};
    return [profile.nickname, profile.soopId].some((value) => String(value || '').toLocaleLowerCase().includes(keyword));
  }) : activeFans;
  if (keyword && !visibleFans.length) {
    const empty = document.createElement('div'); empty.className = 'fan-search-empty'; empty.textContent = '검색 결과가 없습니다.'; host.appendChild(empty); return;
  }
  for (const fan of visibleFans) {
    const row = document.createElement('div'); row.className = 'fan-contact-row';
    const button = document.createElement('button'); button.type = 'button'; button.className = `fan-item${state.selectedFanUid === fan.uid ? ' active' : ''}`;
    const avatar = document.createElement('span'); avatar.className = 'mini-avatar';
    const profile = fan.profile || {};
    button.title = `${profile.nickname || '팬'} 대화 선택하기`;
    if (profile.avatarUrl) { const img = document.createElement('img'); img.src = profile.avatarUrl; img.alt = ''; avatar.appendChild(img); } else avatar.textContent = (profile.nickname || '✦').slice(0, 1);
    const meta = document.createElement('span'); meta.className = 'fan-meta'; const name = document.createElement('strong'); name.textContent = profile.nickname || '팬'; const id = document.createElement('small'); id.textContent = profile.soopId ? `SOOP ${profile.soopId}` : '팬'; meta.append(name, id); button.append(avatar, meta);
    button.addEventListener('click', () => { state.selectedFanUid = fan.uid; $('#member-action').hidden = false; $('#member-action').textContent = '차단'; $('#member-action').title = `${profile.nickname || '선택한 팬'} 차단`; renderFans(); renderTimeline(); });
    const roomself = document.createElement('button'); roomself.type = 'button'; roomself.className = 'fan-roomself-button'; roomself.textContent = '방셀 보내기'; roomself.setAttribute('aria-label', `${profile.nickname || '팬'}에게 방셀 보내기`); roomself.title = `${profile.nickname || '선택한 팬'}에게만 비공개 이미지 보내기`;
    roomself.addEventListener('click', (event) => {
      event.stopPropagation();
      openRoomselfDialog(fan);
    });
    row.append(button, roomself); host.appendChild(row);
  }
}

function openRoomselfDialog(fan) {
  if (!state.isOwner || !state.room || !fan || fan.status !== 'active') return;
  state.roomselfTargetUid = fan.uid;
  $('#roomself-recipient-copy').textContent = `${fan.profile && fan.profile.nickname || '선택한 팬'}님에게만 전달돼요. 갤러리에는 공개되지 않습니다.`;
  $('#roomself-file').value = ''; $('#roomself-preview').hidden = true; $('#roomself-preview').removeAttribute('src');
  $('#roomself-send').disabled = true; $('#roomself-send').textContent = '이미지를 선택해 주세요';
  $('#roomself-status').hidden = true; openDialog('roomself-dialog');
}

async function uploadAndSendRoomself() {
  const file = $('#roomself-file').files && $('#roomself-file').files[0];
  const recipientUid = state.roomselfTargetUid;
  if (!file || !recipientUid || !state.room || file.size > 15 * 1024 * 1024 || !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type)) return;
  const button = $('#roomself-send'); const status = $('#roomself-status');
  button.disabled = true; button.textContent = '업로드 중…'; status.hidden = false; status.textContent = '비공개 버킷에 업로드하고 있습니다.';
  try {
    const prepared = await call('messengerRequestRoomselfUpload', { roomId: state.room.roomId, recipientUid, contentType: file.type, size: file.size });
    const response = await fetch(prepared.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
    if (!response.ok) throw new Error('비공개 이미지 업로드에 실패했습니다. 잠시 후 다시 시도해 주세요.');
    await call('messengerFinalizeRoomselfUpload', { imageId: prepared.imageId });
    closeDialog('roomself-dialog');
    await sendMessage('roomself', prepared.imageId, recipientUid);
  } catch (error) {
    button.disabled = false; button.textContent = '다시 시도';
    status.textContent = error.message || '이미지를 보내지 못했습니다.';
  }
}

function renderBlockedFans() {
  const host = $('#blocked-list'); host.replaceChildren();
  if (!state.blockedFans.length) { host.textContent = '차단된 팬이 없습니다.'; host.className = 'fan-list muted'; return; }
  host.className = 'fan-list';
  for (const fan of state.blockedFans) {
    const row = document.createElement('div'); row.className = 'fan-item';
    const meta = document.createElement('span'); meta.className = 'fan-meta'; const name = document.createElement('strong'); name.textContent = fan.profile.nickname || '팬'; const id = document.createElement('small'); id.textContent = fan.profile.soopId ? `SOOP ${fan.profile.soopId}` : '차단됨'; meta.append(name, id);
    const unblock = document.createElement('button'); unblock.type = 'button'; unblock.className = 'text-button'; unblock.textContent = '해제'; unblock.title = `${fan.profile.nickname || '팬'} 차단 해제`; unblock.addEventListener('click', async () => { try { await call('messengerSetMemberStatus', { roomId: state.room.roomId, uid: fan.uid, status: 'active' }); await loadStreamerLists(); } catch (error) { showError(error); } });
    row.append(meta, unblock); host.appendChild(row);
  }
}

function renderApplications() {
  const host = $('#request-list'); host.replaceChildren();
  $('#request-count').textContent = String(state.applications.length);
  if (!state.applications.length) { host.textContent = '대기 중인 신청이 없습니다.'; return; }
  for (const application of state.applications) {
    const row = document.createElement('div'); row.className = 'request-item';
    const avatar = document.createElement('span'); avatar.className = 'mini-avatar';
    if (application.profile && application.profile.avatarUrl) { const img = document.createElement('img'); img.src = application.profile.avatarUrl; img.alt = ''; avatar.appendChild(img); } else avatar.textContent = (application.profile && application.profile.nickname || '✦').slice(0, 1);
    const meta = document.createElement('span'); meta.className = 'fan-meta'; const name = document.createElement('strong'); name.textContent = application.profile && application.profile.nickname || '팬'; const id = document.createElement('small'); id.textContent = application.profile && application.profile.soopId ? `SOOP ${application.profile.soopId}` : 'SOOP 아이디 없음'; const intro = document.createElement('small'); intro.className = 'request-intro'; intro.textContent = application.intro || '소개 없음'; meta.append(name, id, intro);
    const actions = document.createElement('span'); actions.className = 'request-actions';
    for (const [decision, label] of [['approved', '승인'], ['rejected', '거절']]) { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.title = `${application.profile && application.profile.nickname || '팬'} 채팅 신청 ${label}`; if (decision === 'rejected') button.className = 'reject'; button.addEventListener('click', async () => { try { await call('messengerReviewApplication', { roomId: state.room.roomId, uid: application.uid, decision }); await loadStreamerLists(); } catch (error) { showError(error); } }); actions.appendChild(button); }
    row.append(avatar, meta, actions); host.appendChild(row);
  }
}

function updateRecipientSelect() {
  const select = $('#direct-recipient'); select.replaceChildren();
  const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = '팬 선택'; select.appendChild(placeholder);
  for (const fan of state.fans.filter((x) => x.status === 'active')) { const option = document.createElement('option'); option.value = fan.uid; option.textContent = `${fan.profile.nickname || '팬'} · ${fan.profile.soopId || ''}`; select.appendChild(option); }
}

function setReply(message) {
  state.currentReply = message; $('#message-audience').value = 'direct'; $('#direct-recipient').hidden = false; $('#direct-recipient').value = message.senderUid;
  $('#replying-label').textContent = `${message.senderName || '팬'}에게 답변 중`;
  $('#replying-to').hidden = false; $('#message-input').focus();
}

async function sendMessage(kind = 'text', imageId = '', targetUid = '', messageText = null, audienceOverride = null) {
  if (!state.room || !state.session) return false;
  const preserveDraft = messageText !== null;
  const text = String(preserveDraft ? messageText : $('#message-input').value).trim();
  if (kind === 'text' && !text) return false;
  const audience = state.isOwner ? (audienceOverride || $('#message-audience').value) : 'direct';
  const recipientUid = state.isOwner ? (targetUid || (audience === 'direct' ? $('#direct-recipient').value : '')) : '';
  if (state.isOwner && audience === 'direct' && !recipientUid) { showError({ message: '다이렉트 메시지를 받을 팬을 선택해 주세요.' }); return false; }
  const room = state.room;
  const uid = state.session.uid;
  const isOwner = state.isOwner;
  const reply = state.currentReply;
  const recipientFan = recipientUid ? state.fans.find((fan) => fan.uid === recipientUid) : null;
  const messageId = api().push(api().ref(api().db, `streamerMessenger/chat/${room.roomId}/streamerTimeline`)).key;
  const senderProfile = isOwner
    ? { nickname: room.streamerNickname || '스트리머', avatarUrl: room.streamerAvatarUrl || '' }
    : (state.session.profile || {});
  const message = {
    id: messageId, roomId: room.roomId, senderUid: uid,
    senderRole: isOwner ? 'streamer' : 'fan', senderName: senderProfile.nickname || (isOwner ? '스트리머' : '팬'),
    senderAvatarUrl: senderProfile.avatarUrl || '', createdAt: Date.now(), recipientUid: recipientUid || null,
    ...(recipientUid && recipientFan && recipientFan.profile && recipientFan.profile.nickname ? { recipientName: recipientFan.profile.nickname } : {}),
    kind, ...(kind === 'image' ? { galleryImageId: imageId } : kind === 'roomself' ? { roomselfImageId: imageId } : { text }),
    scope: isOwner ? (recipientUid ? (reply && reply.id ? 'reply' : 'direct') : 'broadcast') : 'fan', pending: true,
    ...(reply && reply.id ? { replyToId: reply.id, replyToUid: reply.senderUid } : {}),
  };
  state.optimisticMessages.push(message);
  state.messages = combineMessages(state.olderMessages, state.olderPrivateMessages, state.olderBroadcastMessages, state.liveMessages, state.privateMessages, state.broadcastMessages, state.optimisticMessages);
  renderTimeline();
  if (kind === 'text' && !preserveDraft) $('#message-input').value = '';
  state.currentReply = null; $('#replying-to').hidden = true;
  try {
    await call('messengerSendMessage', { roomId: room.roomId, clientMessageId: messageId, kind, text, galleryImageId: kind === 'image' ? imageId : '', roomselfImageId: kind === 'roomself' ? imageId : '', recipientUid, replyToId: reply && reply.id, replyToUid: reply && reply.senderUid });
    if (state.room && state.room.roomId === room.roomId) {
      const optimistic = state.optimisticMessages.find((item) => item.id === messageId);
      if (optimistic) { optimistic.pending = false; renderTimeline(); }
    }
    return true;
  } catch (error) {
    if (state.room && state.room.roomId === room.roomId) {
      state.optimisticMessages = state.optimisticMessages.filter((item) => item.id !== messageId);
      state.messages = state.messages.filter((item) => item.id !== messageId);
      if (kind === 'text' && !preserveDraft && !$('#message-input').value) $('#message-input').value = text;
      renderTimeline();
    }
    showError(error);
    return false;
  }
}

async function openImagePicker(targetUid = '') {
  if (!state.room) return;
  const targetFan = targetUid ? state.fans.find((fan) => fan.uid === targetUid && fan.status === 'active') : null;
  if (targetUid && (!state.isOwner || !targetFan)) { showError({ message: '참여 중인 팬에게만 방셀을 보낼 수 있어요.' }); return; }
  state.galleryTargetUid = targetFan ? targetFan.uid : '';
  $('#gallery-picker-copy').textContent = targetFan
    ? `${targetFan.profile && targetFan.profile.nickname || '선택한 팬'}님에게만 보낼 이미지예요. 이미지를 누르면 1:1 대화로 전송돼요.`
    : '이미지를 누르면 채팅으로 전송돼요. 새 사진은 아래에서 업로드할 수 있어요.';
  $('#gallery-image-list').innerHTML = '<div class="gallery-loading" role="status"><span class="loading-spinner" aria-hidden="true"></span><span>갤러리 사진을 불러오는 중…</span></div>'; $('#gallery-locked').hidden = true;
  $('#gallery-inline-upload-panel').hidden = true; $('#gallery-open-row').hidden = false;
  $('#gallery-inline-file').value = ''; $('#gallery-inline-filename').textContent = '선택한 파일 없음'; $('#gallery-inline-status').hidden = true; $('#gallery-inline-status').textContent = '';
  state.galleryStreamerId = '';
  openDialog('image-picker-dialog');
  await loadGalleryImages();
}

async function loadGalleryImages() {
  const room = state.room;
  if (!room) return;
  try {
    const result = await call('messengerGetGalleryImages', { roomId: room.roomId });
    if (!state.room || state.room.roomId !== room.roomId) return;
    if (result.linked === false) { $('#gallery-image-list').innerHTML = '<p class="muted">이 채팅방의 SOOP 아이디와 연결된 갤러리 스트리머를 찾지 못했어요. 프로필의 SOOP 아이디가 갤러리 스트리머 정보와 일치하는지 확인해 주세요.</p>'; return; }
    state.galleryStreamerId = result.streamerId || '';
    if (result.locked) { $('#gallery-locked').hidden = false; $('#gallery-image-list').innerHTML = '<p class="muted">해금 후 이미지를 선택할 수 있어요.</p>'; return; }
    const grid = $('#gallery-image-list'); grid.replaceChildren();
    const images = result.images || [];
    $('#gallery-inline-upload-panel').hidden = false;
    $('#gallery-open-row').hidden = false;
    for (const item of images) {
      state.galleryImages.set(item.imageId, item);
      const button = document.createElement('button'); button.className = 'gallery-image-button'; button.type = 'button'; button.title = new Date(item.createdAt).toLocaleDateString('ko-KR');
      const img = document.createElement('img'); img.src = item.thumbUrl || item.imageUrl; img.alt = '갤러리 이미지'; img.loading = 'lazy'; button.appendChild(img);
      button.addEventListener('click', async () => { const targetUid = state.galleryTargetUid; closeDialog('image-picker-dialog'); await sendMessage('image', item.imageId, targetUid); });
      grid.appendChild(button);
    }
    if (!images.length) grid.innerHTML = '<p class="muted">이 스트리머 갤러리에 등록된 사진이 아직 없습니다.</p>';
  } catch (error) {
    if (state.room && state.room.roomId === room.roomId && $('#image-picker-dialog').open) {
      $('#gallery-image-list').innerHTML = '<p class="muted">갤러리 사진을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.</p>';
    }
    showError(error);
  }
}

function makeGalleryThumbnail(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      const width = image.naturalWidth; const height = image.naturalHeight;
      const scale = Math.min(1, 480 / Math.max(width, height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => blob ? resolve({ blob, width, height }) : reject(new Error('사진 미리보기를 만들지 못했습니다.')), 'image/jpeg', 0.82);
    };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('사진 파일을 읽을 수 없습니다.')); };
    image.src = url;
  });
}

async function uploadGalleryImageFromPicker() {
  const fileInput = $('#gallery-inline-file');
  const file = fileInput.files && fileInput.files[0];
  const status = $('#gallery-inline-status');
  const button = $('#gallery-inline-upload');
  const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
  if (!state.room || !file) { status.textContent = '먼저 업로드할 사진을 선택해 주세요.'; status.hidden = false; return; }
  if (!allowedTypes.has(file.type)) { status.textContent = 'JPG, PNG, WebP, GIF 사진만 업로드할 수 있어요.'; status.hidden = false; return; }
  if (file.size > 15 * 1024 * 1024) { status.textContent = '사진 용량은 15MB 이하여야 해요.'; status.hidden = false; return; }
  const room = state.room;
  const streamerId = state.galleryStreamerId;
  if (!streamerId) { status.textContent = '이 채팅방의 스트리머 갤러리를 확인하지 못했습니다. 다시 열어 주세요.'; status.hidden = false; return; }
  button.disabled = true; button.textContent = '업로드 중…'; status.hidden = false; status.textContent = '사진을 갤러리에 업로드하고 있어요.';
  try {
    const thumb = await makeGalleryThumbnail(file);
    const prepared = await call('requestImageUpload', { contentType: file.type, fileSize: file.size, thumbFileSize: thumb.blob.size });
    const originalUpload = await fetch(prepared.uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
    if (!originalUpload.ok) throw new Error('원본 사진을 스토리지에 올리지 못했습니다. 다시 시도해 주세요.');
    const thumbnailUpload = await fetch(prepared.thumbUploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: thumb.blob });
    if (!thumbnailUpload.ok) throw new Error('사진 미리보기를 스토리지에 올리지 못했습니다. 다시 시도해 주세요.');
    const streamerNameSnapshot = await api().get(api().ref(api().db, `streamerNames/${streamerId}`)).catch(() => null);
    const streamerName = streamerNameSnapshot && streamerNameSnapshot.val() || room.streamerNickname || '스트리머';
    await registerGalleryImageWithRetry({
      imageId: prepared.imageId, key: prepared.key, thumbKey: prepared.thumbKey,
      streamerId, streamerName,
      category: $('#gallery-inline-category').value, width: thumb.width, height: thumb.height,
    }, (attempt) => { status.textContent = `갤러리 등록 재시도 중… (${attempt}/3)`; });
    fileInput.value = '';
    status.textContent = '업로드 완료! 사진을 불러오는 중이에요.';
    if (state.room && state.room.roomId === room.roomId && $('#image-picker-dialog').open) await loadGalleryImages();
  } catch (error) {
    status.textContent = error.message || '사진 업로드에 실패했습니다.';
  } finally {
    button.disabled = false; button.textContent = '갤러리에 사진 업로드';
  }
}

async function submitApplication() {
  if (!state.room) return;
  const errorEl = $('#application-error'); errorEl.hidden = true;
  try {
    await call('messengerApplyToRoom', { roomId: state.room.roomId, password: $('#application-password').value, intro: $('#application-intro').value });
    closeDialog('application-dialog'); showError({ message: '대화 신청을 보냈습니다. 스트리머가 확인하면 알려드릴게요.' });
  } catch (error) { errorEl.textContent = error.message || '신청을 보내지 못했습니다.'; errorEl.hidden = false; }
}

async function openOwnRoom() {
  setRoomEntryLoading(true);
  try {
    const result = await call('messengerEnsureRoom');
    state.session.ownRoom = result.room;
    subscribeOwnerApplications(result.room);
    syncHeader();
    upsertRoom(result.room);
    const room = result.room;
    await openChat(room, true);
    if (result.created) { prepareRoomSettings(); openDialog('room-settings-dialog'); }
  } catch (error) { showError(error); }
  finally { setRoomEntryLoading(false); }
}

async function saveRoomSettings() {
  const visibility = $('#room-visibility').value;
  const saveButton = $('#save-room-settings');
  if (saveButton.dataset.saving === 'true') return;
  if (saveButton.dataset.saved === 'true') {
    closeDialog('room-settings-dialog'); saveButton.dataset.saved = 'false'; return;
  }
  saveButton.dataset.saving = 'true'; saveButton.disabled = true; saveButton.textContent = '저장 중…';
  try {
    const repeatTextDelaySeconds = Number($('#room-repeat-text-delay').value);
    const repeatLinkDelaySeconds = Number($('#room-repeat-link-delay').value);
    if (![repeatTextDelaySeconds, repeatLinkDelaySeconds].every((value) => Number.isInteger(value) && value >= 0 && value <= 3600)) {
      throw new Error('반복 차단 시간은 0~3600초 사이의 정수로 입력해 주세요.');
    }
    const result = await call('messengerUpdateRoom', { roomId: state.room.roomId, visibility, regeneratePassword: state.regenerateRoomPassword, locked: $('#room-locked').checked, repeatTextDelaySeconds, repeatLinkDelaySeconds, memberPolicy: $('#room-member-policy').value });
    state.room = result.room; state.regenerateRoomPassword = false; renderRoomState(state.room); upsertRoom(result.room);
    if (result.generatedPassword) {
      $('#generated-room-password').value = result.generatedPassword;
      $('#generated-password-wrap').hidden = false;
      $('#room-password-copy-status').textContent = '비밀번호를 복사해 팬에게 전달하세요. 이 창을 닫으면 다시 확인할 수 없습니다.';
      $('#room-password-copy-status').hidden = false;
      $('#room-visibility').disabled = true; $('#room-locked').disabled = true; $('#room-repeat-text-delay').disabled = true; $('#room-repeat-link-delay').disabled = true; $('#room-member-policy').disabled = true; $('#regenerate-room-password').disabled = true;
      saveButton.textContent = '완료'; saveButton.dataset.saved = 'true';
      updateRoomPasswordControls();
    } else {
      saveButton.textContent = '설정 저장'; saveButton.dataset.saved = 'false';
      closeDialog('room-settings-dialog');
    }
  } catch (error) {
    saveButton.textContent = '설정 저장'; saveButton.dataset.saved = 'false';
    showError(error);
  } finally {
    saveButton.dataset.saving = 'false'; saveButton.disabled = false;
  }
}

function updateRoomPasswordControls() {
  const isPrivate = $('#room-visibility').value === 'private';
  const needsNewPassword = isPrivate && (state.room.visibility !== 'private' || state.regenerateRoomPassword);
  $('#room-password-wrap').hidden = !isPrivate;
  $('#regenerate-room-password').hidden = !isPrivate || state.room.visibility !== 'private';
  $('#regenerate-room-password').textContent = state.regenerateRoomPassword ? '발급 예약 취소' : '새 비밀번호 발급';
  $('#room-password-help').textContent = needsNewPassword
    ? '저장하면 전달하기 쉬운 새 비밀번호를 자동 발급합니다.'
    : '현재 비밀번호는 다시 확인할 수 없습니다. 새로 발급하면 기존 비밀번호는 사용할 수 없게 됩니다.';
  $('#room-member-policy-wrap').hidden = !needsNewPassword;
  if (!isPrivate) state.regenerateRoomPassword = false;
}

function prepareRoomSettings() {
  $('#room-visibility').value = state.room.visibility || 'public';
  $('#room-locked').checked = state.room.locked === true;
  $('#room-repeat-text-delay').value = String(Number(state.room.repeatTextDelaySeconds) || 0);
  $('#room-repeat-link-delay').value = String(Number(state.room.repeatLinkDelaySeconds) || 0);
  $('#room-member-policy').value = 'keep';
  $('#room-visibility').disabled = false; $('#room-locked').disabled = false; $('#room-repeat-text-delay').disabled = false; $('#room-repeat-link-delay').disabled = false; $('#room-member-policy').disabled = false; $('#regenerate-room-password').disabled = false;
  state.regenerateRoomPassword = false;
  $('#generated-room-password').value = '';
  $('#generated-password-wrap').hidden = true;
  $('#room-password-copy-status').hidden = true;
  $('#save-room-settings').textContent = '설정 저장';
  $('#save-room-settings').dataset.saved = 'false';
  updateRoomPasswordControls();
}

async function copyRoomPassword() {
  const input = $('#generated-room-password');
  input.focus(); input.select(); input.setSelectionRange(0, input.value.length);
  try {
    await navigator.clipboard.writeText(input.value);
    $('#room-password-copy-status').textContent = '비밀번호를 복사했습니다. 팬에게 붙여넣어 전달하세요.';
  } catch (_) {
    const copied = document.execCommand('copy');
    $('#room-password-copy-status').textContent = copied ? '비밀번호를 복사했습니다. 팬에게 붙여넣어 전달하세요.' : '비밀번호를 선택했습니다. 복사해 팬에게 전달하세요.';
  }
}

async function discardRoom() {
  const ok = await new Promise((resolve) => {
    const dialog = $('#generic-dialog'); $('#generic-message').textContent = '채팅방, 참여자, 대기 신청, 서버 대화가 즉시 삭제됩니다. 신고 보존 중인 자료는 보관 기간까지 유지됩니다. 방을 폐기할까요?';
    const yes = $('#generic-confirm'); const no = $('#generic-cancel');
    const finish = (value) => { dialog.close(); yes.removeEventListener('click', onYes); no.removeEventListener('click', onNo); resolve(value); };
    const onYes = () => finish(true); const onNo = () => finish(false);
    yes.addEventListener('click', onYes); no.addEventListener('click', onNo); dialog.showModal();
  });
  if (!ok) return;
  try {
    await call('messengerDiscardRoom', { roomId: state.room.roomId });
    const result = await call('messengerEnsureRoom');
    state.session.ownRoom = result.room; subscribeOwnerApplications(result.room); syncHeader(); upsertRoom(result.room);
    closeDialog('room-settings-dialog'); leaveChat();
    showError({ message: '새 채팅방을 만들었습니다. 공개/비공개 설정을 확인해 주세요.' });
  }
  catch (error) { showError(error); }
}

function leaveChat() {
  clearSubscriptions();
  state.room = null; state.activeView = 'directory'; state.selectedFanUid = '';
  state.miniGame = null; state.miniGameSelectedLane = -1; state.miniGameSelectedId = '';
  state.activeRoomTool = 'market'; state.roomToolTabKeys = ''; state.renderedMiniGameId = '';
  $('#room-tools-sticky-slot').hidden = true;
  $('#room-tool-market-slide').hidden = true;
  $('#room-tool-mini-game-slide').hidden = true;
  $('#room-market-panel').hidden = true;
  $('#mini-game-active').hidden = true;
  closeDialog('mini-game-dialog');
  state.messages = []; state.liveMessages = []; state.olderMessages = [];
  state.privateMessages = []; state.broadcastMessages = [];
  state.olderPrivateMessages = []; state.olderBroadcastMessages = [];
  state.optimisticMessages = []; state.galleryImages.clear(); state.imageUrls.clear();
  $('#page-shell').classList.remove('chat-open');
  $('#chat-view').hidden = true; $('#directory-view').hidden = false;
}

function switchAside(tab) {
  document.querySelectorAll('.aside-tab').forEach((button) => button.classList.toggle('active', button.dataset.listTab === tab));
  $('#fan-search-wrap').hidden = tab !== 'fans';
  $('#fan-list').hidden = tab !== 'fans'; $('#request-list').hidden = tab !== 'requests';
  $('#blocked-list').hidden = tab !== 'blocked';
}

async function showAdmin() {
  if (!state.session || !state.session.isAdmin) return;
  leaveChat(); $('#directory-view').hidden = true; $('#admin-view').hidden = false;
  adminState.reportStatus = $('#admin-report-status').value || 'pending';
  adminState.reports = []; adminState.reportCursor = null; adminState.reportHasMore = false;
  adminState.bans = []; adminState.banCursor = null; adminState.banHasMore = false; adminState.bansLoaded = false;
  $('#admin-report-list').textContent = '신고 목록을 불러옵니다.';
  $('#admin-audit-list').textContent = '관리 기록을 불러옵니다.';
  $('#admin-ban-status').textContent = 'UID를 확인하면 메신저 및 전체 서비스 정지 상태가 표시됩니다.';
  $('#admin-ban-actions').hidden = true;
  $('#admin-ban-uid').value = ''; $('#admin-ban-reason').value = '';
  $('#admin-ban-list').textContent = '계정 탭을 열면 목록을 불러옵니다.';
  switchAdminTab('reports');
  await loadAdminReportPage(true);
}

async function loadAdminReportPage(reset = false) {
  if (adminState.reportsLoading) return;
  if (reset) {
    adminState.reportStatus = $('#admin-report-status').value || 'pending';
    adminState.reports = []; adminState.reportCursor = null; adminState.reportHasMore = false;
    $('#admin-report-list').textContent = '신고 목록을 불러옵니다.';
  }
  adminState.reportsLoading = true;
  $('#admin-report-refresh').disabled = true; $('#admin-report-load-more').disabled = true;
  try {
    const result = await call('messengerAdminGetDashboard', {
      reportStatus: adminState.reportStatus,
      reportCursor: reset ? null : adminState.reportCursor,
    });
    $('#admin-pending-count').textContent = String(result.summary && result.summary.pendingReports || 0);
    $('#admin-ban-count').textContent = String(result.summary && result.summary.activeBans || 0);
    renderAdminAudit(result.auditLog || []);
    adminState.reports.push(...(Array.isArray(result.reports) ? result.reports : []));
    adminState.reportCursor = result.reportPage && result.reportPage.nextCursor || null;
    adminState.reportHasMore = !!(result.reportPage && result.reportPage.hasMore);
    renderAdminReports(adminState.reports);
    $('#admin-report-load-more').hidden = !adminState.reportHasMore;
  } catch (error) {
    if (reset) $('#admin-report-list').textContent = error.message || '신고 목록을 불러오지 못했습니다.';
    else showError(error);
  } finally {
    adminState.reportsLoading = false;
    $('#admin-report-refresh').disabled = false; $('#admin-report-load-more').disabled = false;
  }
}

function renderAdminReports(reports) {
  const host = $('#admin-report-list'); host.replaceChildren();
  if (!reports.length) { host.textContent = adminState.reportStatus === 'pending' ? '대기 중인 신고가 없습니다.' : '이 상태의 신고가 없습니다.'; return; }
  const reasonLabels = { harassment: '욕설·괴롭힘', spam: '도배·스팸·광고', privacy: '개인정보 노출', sexual: '성적 콘텐츠', impersonation: '사칭·기만', other: '기타' };
  for (const report of reports) {
    const card = document.createElement('article'); card.className = 'admin-report-card';
    const copy = document.createElement('div');
    const status = report.status || 'pending';
    const statusLabel = ({ pending: '대기', reviewed: '확인 완료', dismissed: '기각' })[status] || status;
    const title = document.createElement('strong'); title.textContent = `신고 ${statusLabel} · ${new Date(report.createdAt || 0).toLocaleString('ko-KR')}`;
    const reason = document.createElement('p'); reason.textContent = `${reasonLabels[report.reasonCategory] || report.reason || '사유 없음'}${report.reasonDetail ? ` · ${report.reasonDetail}` : ''}`;
    const details = document.createElement('p'); details.textContent = `신고 ID ${report.id} · 신고자 ${report.reporterUid || '확인 불가'} · 대상 ${report.targetUid || '확인 불가'} · 방 ${report.roomId || '확인 불가'}`;
    const range = document.createElement('p'); range.textContent = `대화 범위 ${new Date(report.rangeStart || 0).toLocaleString('ko-KR')} – ${new Date(report.rangeEnd || 0).toLocaleString('ko-KR')}`;
    copy.append(title, reason, details, range);
    if (report.reviewNote) { const note = document.createElement('p'); note.className = 'admin-report-note'; note.textContent = `최근 처리 의견: ${report.reviewNote}`; copy.appendChild(note); }
    const actions = document.createElement('div'); actions.className = 'report-actions';
    const detailButton = document.createElement('button'); detailButton.type = 'button'; detailButton.textContent = '증거·처리 보기'; detailButton.addEventListener('click', async () => { try { await showReportEvidence(report.id); } catch (error) { showError(error); } }); actions.appendChild(detailButton);
    if (status === 'pending' && report.targetUid) {
      const restrictButton = document.createElement('button'); restrictButton.type = 'button'; restrictButton.textContent = '계정 제한 확인'; restrictButton.addEventListener('click', () => { $('#admin-ban-uid').value = report.targetUid; switchAdminTab('accounts'); checkMessengerBan(); }); actions.appendChild(restrictButton);
    }
    card.append(copy, actions); host.appendChild(card);
  }
}

function renderAdminAudit(entries) {
  const host = $('#admin-audit-list'); host.replaceChildren();
  if (!entries.length) { host.textContent = '관리 기록이 없습니다.'; return; }
  const labels = { 'report.submit': '신고 접수', 'report.view': '신고 증거 열람', 'report.private-image.view': '비공개 이미지 증거 열람', 'report.reviewed': '신고 확인 완료', 'report.dismissed': '신고 기각', 'report.reopened': '신고 재검토 대기', 'account.status.view': '계정 제한 상태 조회', 'account.ban': '메신저 이용 정지', 'account.unban': '메신저 이용 정지 해제' };
  for (const entry of entries) {
    const row = document.createElement('article'); row.className = 'admin-audit-card';
    const title = document.createElement('strong'); title.textContent = labels[entry.action] || entry.action || '관리 조치';
    const meta = document.createElement('p'); meta.textContent = `${new Date(entry.at || 0).toLocaleString('ko-KR')} · 작업자 UID ${entry.actorUid || '확인 불가'}`;
    const detail = document.createElement('small'); detail.textContent = entry.detail || '';
    row.append(title, meta, detail); host.appendChild(row);
  }
}

function switchAdminTab(tab) {
  document.querySelectorAll('[data-admin-tab]').forEach((button) => button.classList.toggle('active', button.dataset.adminTab === tab));
  ['reports', 'accounts', 'audit'].forEach((name) => { $(`#admin-pane-${name}`).hidden = name !== tab; });
  if (tab === 'accounts' && !adminState.bansLoaded && !adminState.bansLoading) loadAdminBanPage(true);
}

async function loadAdminBanPage(reset = false) {
  if (adminState.bansLoading) return;
  if (reset) {
    adminState.bans = []; adminState.banCursor = null; adminState.banHasMore = false;
    $('#admin-ban-list').textContent = '정지 계정 목록을 불러옵니다.';
  }
  adminState.bansLoading = true;
  $('#admin-ban-refresh').disabled = true; $('#admin-ban-load-more').disabled = true;
  try {
    const result = await call('messengerAdminGetDashboard', { includeBans: true, includeReports: false, banCursor: reset ? null : adminState.banCursor });
    adminState.bans.push(...(Array.isArray(result.bans) ? result.bans : []));
    adminState.banCursor = result.banPage && result.banPage.nextCursor || null;
    adminState.banHasMore = !!(result.banPage && result.banPage.hasMore);
    adminState.bansLoaded = true;
    $('#admin-ban-count').textContent = String(result.summary && result.summary.activeBans || 0);
    renderAdminBans();
    $('#admin-ban-load-more').hidden = !adminState.banHasMore;
  } catch (error) { $('#admin-ban-list').textContent = error.message || '정지 계정 목록을 불러오지 못했습니다.'; }
  finally { adminState.bansLoading = false; $('#admin-ban-refresh').disabled = false; $('#admin-ban-load-more').disabled = false; }
}

function renderAdminBans() {
  const host = $('#admin-ban-list'); host.replaceChildren();
  const query = $('#admin-ban-search').value.trim().toLowerCase();
  const filtered = adminState.bans.filter((ban) => !query || String(ban.uid || '').toLowerCase().includes(query));
  if (!filtered.length) { host.textContent = query ? '불러온 페이지에 일치하는 UID가 없습니다. 다음 페이지도 확인해 주세요.' : '메신저 전용 정지 계정이 없습니다.'; return; }
  for (const ban of filtered) {
    const row = document.createElement('article'); row.className = 'admin-ban-row';
    const copy = document.createElement('div');
    const uid = document.createElement('strong'); uid.textContent = ban.uid;
    const detail = document.createElement('p'); detail.textContent = `${ban.reason || '사유 없음'} · ${new Date(ban.at || 0).toLocaleString('ko-KR')}`;
    copy.append(uid, detail);
    const button = document.createElement('button'); button.type = 'button'; button.className = 'button button-quiet'; button.textContent = '상태 확인'; button.addEventListener('click', () => { $('#admin-ban-uid').value = ban.uid; checkMessengerBan(); });
    row.append(copy, button); host.appendChild(row);
  }
}

async function checkMessengerBan() {
  const uid = $('#admin-ban-uid').value.trim();
  const status = $('#admin-ban-status'); const actions = $('#admin-ban-actions');
  status.textContent = '상태를 확인하고 있습니다.'; actions.hidden = true;
  try {
    const result = await call('messengerAdminGetBanStatus', { uid });
    const ban = result.ban;
    const lines = [];
    if (result.globalBan) lines.push(`전체 서비스 정지 중 · ${result.globalBan.reason || '사유 없음'} · ${new Date(result.globalBan.at || 0).toLocaleString('ko-KR')} (해제는 통합관리센터에서 처리)`);
    else lines.push('전체 서비스 정지 상태가 아닙니다.');
    if (ban) lines.push(`메신저 전용 정지 중 · ${ban.reason || '사유 없음'} · ${new Date(ban.at || 0).toLocaleString('ko-KR')}`);
    else lines.push('메신저 전용 정지 상태가 아닙니다.');
    if (result.isAdmin) lines.push('관리자 계정은 메신저 이용 정지 대상이 아닙니다.');
    status.textContent = lines.join(' ');
    $('#admin-ban-submit').hidden = !!ban || !!result.isAdmin; $('#admin-unban-submit').hidden = !ban;
    $('#admin-ban-reason').value = '';
    actions.hidden = !!result.isAdmin;
  } catch (error) { status.textContent = error.message || '계정 상태를 확인하지 못했습니다.'; }
}

async function setMessengerBan(banned) {
  const uid = $('#admin-ban-uid').value.trim();
  const reason = $('#admin-ban-reason').value.trim();
  if (banned && !reason) { showError({ message: '정지 사유를 입력해 주세요.' }); return; }
  if (!window.confirm(banned ? '이 계정의 메신저 이용을 정지할까요? 다른 서비스에는 적용되지 않습니다.' : '이 계정의 메신저 이용 정지를 해제할까요?')) return;
  const button = banned ? $('#admin-ban-submit') : $('#admin-unban-submit'); button.disabled = true;
  try {
    await call('messengerAdminSetBan', { uid, banned, reason });
    await showAdmin();
    $('#admin-ban-uid').value = uid;
    await checkMessengerBan();
    switchAdminTab('accounts');
    showToast(banned ? '메신저 이용을 정지했습니다.' : '메신저 이용 정지를 해제했습니다.');
  } catch (error) { showError(error); }
  finally { button.disabled = false; }
}

async function showReportEvidence(reportId) {
  const result = await call('messengerAdminGetReportDetail', { reportId });
  adminState.currentReport = result.report;
  const report = result.report || {};
  const status = report.status || 'pending';
  const statusLabel = ({ pending: '대기', reviewed: '확인 완료', dismissed: '기각' })[status] || status;
  const reasonLabels = { harassment: '욕설·괴롭힘', spam: '도배·스팸·광고', privacy: '개인정보 노출', sexual: '성적 콘텐츠', impersonation: '사칭·기만', other: '기타' };
  const meta = $('#report-detail-meta'); meta.replaceChildren();
  const summary = [
    `상태: ${statusLabel}`,
    `신고 ID: ${report.id || reportId}`,
    `신고자 UID: ${report.reporterUid || '확인 불가'}`,
    `대상 UID: ${report.targetUid || '확인 불가'}`,
    `방 ID: ${report.roomId || '확인 불가'}`,
    `접수 시각: ${new Date(report.createdAt || 0).toLocaleString('ko-KR')}`,
    `신고 사유: ${reasonLabels[report.reasonCategory] || report.reason || '사유 없음'}${report.reasonDetail ? ` · ${report.reasonDetail}` : ''}`,
    `대화 범위: ${new Date(report.rangeStart || 0).toLocaleString('ko-KR')} – ${new Date(report.rangeEnd || 0).toLocaleString('ko-KR')}`,
  ];
  if (report.reviewedAt) summary.push(`최근 처리: ${new Date(report.reviewedAt).toLocaleString('ko-KR')} · 작업자 UID ${report.reviewedBy || '확인 불가'}${report.reviewNote ? ` · ${report.reviewNote}` : ''}`);
  summary.forEach((text) => { const line = document.createElement('p'); line.textContent = text; meta.appendChild(line); });
  $('#report-review-note').value = '';
  $('#report-mark-reviewed').hidden = status !== 'pending';
  $('#report-mark-dismissed').hidden = status !== 'pending';
  $('#report-reopen').hidden = status === 'pending';
  const host = $('#report-evidence-list'); host.replaceChildren();
  for (const message of result.evidence || []) {
    const row = document.createElement('article'); row.className = 'report-evidence-item';
    const label = document.createElement('small'); label.textContent = `${message.senderName || '사용자'} · ${new Date(message.createdAt || 0).toLocaleString('ko-KR')}`;
    const body = document.createElement('p'); body.textContent = message.kind === 'image' ? `갤러리 이미지 첨부 (${message.galleryImageId})` : message.kind === 'roomself' ? '비공개 방셀 이미지' : (message.text || '');
    row.append(label, body);
    if (message.kind === 'image') {
      if (message.reportImageUrl) { const image = document.createElement('img'); image.src = message.reportImageUrl; image.alt = '신고 증거 이미지'; image.loading = 'lazy'; image.className = 'report-evidence-image'; row.appendChild(image); }
      else { const unavailable = document.createElement('small'); unavailable.textContent = '원본 이미지가 삭제되어 표시할 수 없습니다.'; row.appendChild(unavailable); }
    } else if (message.kind === 'roomself' && message.roomselfImageId) {
      try {
        const imageData = await call('messengerAdminGetReportRoomselfImage', { reportId, imageId: message.roomselfImageId });
        const image = document.createElement('img'); image.src = roomselfDataUrl(imageData); image.alt = '신고된 비공개 방셀 증거'; image.className = 'report-evidence-image'; row.appendChild(image);
      } catch (_) { const unavailable = document.createElement('small'); unavailable.textContent = '비공개 이미지 보존 기간이 끝났거나 불러올 수 없습니다.'; row.appendChild(unavailable); }
    }
    host.appendChild(row);
  }
  if (!host.children.length) host.textContent = '보관된 대화 증거가 없습니다.';
  openDialog('report-detail-dialog');
}

async function updateAdminReportStatus(status) {
  const report = adminState.currentReport;
  if (!report || !report.id) return;
  const note = $('#report-review-note').value.trim();
  if (!note) { showError({ message: '처리 의견을 입력해 주세요.' }); return; }
  const action = ({ reviewed: '확인 완료', dismissed: '기각', pending: '대기 상태로 되돌리기' })[status] || '처리';
  if (!window.confirm(`신고를 ${action}로 처리할까요?\n처리 의견: ${note}`)) return;
  const buttons = ['#report-mark-reviewed', '#report-mark-dismissed', '#report-reopen'].map((selector) => $(selector));
  buttons.forEach((button) => { button.disabled = true; });
  try {
    await call('messengerAdminUpdateReport', { reportId: report.id, status, reviewNote: note });
    closeDialog('report-detail-dialog');
    adminState.currentReport = null;
    if (status === 'pending') $('#admin-report-status').value = 'pending';
    showToast(status === 'pending' ? '신고를 대기 상태로 되돌렸습니다.' : `신고를 ${action} 처리했습니다.`);
    await loadAdminReportPage(true);
  } catch (error) { showError(error); }
  finally { buttons.forEach((button) => { button.disabled = false; }); }
}

function openProfile() {
  if (!state.session || !state.session.trusted) { openDialog('auth-dialog'); return; }
  const profile = state.session.profile || {};
  $('#profile-soop-nickname').value = profile.nickname || (state.session.streamer && state.session.streamer.nickname) || '';
  $('#profile-soop-id').value = profile.soopId || (state.session.streamer && state.session.streamer.soopId) || '';
  updateProfilePreview();
  openDialog('profile-dialog');
}

function updateProfilePreview() {
  const image = $('#profile-avatar-preview');
  const fallback = $('#avatar-fallback');
  const src = avatarUrl($('#profile-soop-id').value);
  image.hidden = true;
  fallback.hidden = false;
  image.onload = () => { image.hidden = false; fallback.hidden = true; };
  image.onerror = () => { image.hidden = true; fallback.hidden = false; };
  if (src) {
    image.src = src;
    if (image.complete && image.naturalWidth > 0) { image.hidden = false; fallback.hidden = true; }
  } else image.removeAttribute('src');
}

async function saveProfile() {
  const saveButton = $('#save-profile');
  if (saveButton.dataset.saving === 'true') return;
  const nickname = $('#profile-soop-nickname').value.trim(); const soopId = $('#profile-soop-id').value.trim().toLowerCase();
  if (!nickname || !soopId) { showError({ message: 'SOOP 닉네임과 아이디를 입력해 주세요.' }); return; }
  if (nickname.length > 12 || /[<>\x00-\x1f\x7f]/.test(nickname) || !/^[a-z0-9]{2,20}$/.test(soopId)) { showError({ message: '닉네임은 12자 이하, SOOP 아이디는 영문 소문자와 숫자 2~20자로 입력해 주세요.' }); return; }
  const originalText = saveButton.textContent;
  saveButton.dataset.saving = 'true'; saveButton.disabled = true; saveButton.textContent = '저장 중…';
  try {
    await call('updateGalleryProfile', { nickname, soopId });
    await api().refreshSession(api().auth.currentUser);
    closeDialog('profile-dialog');
    showToast('프로필 저장 완료');
  } catch (error) { showError(error); }
  finally { saveButton.dataset.saving = 'false'; saveButton.disabled = false; saveButton.textContent = originalText; }
}

async function enableNotifications() {
  if (!('Notification' in window)) { showError({ message: '이 브라우저는 알림을 지원하지 않습니다.' }); return; }
  const permission = await Notification.requestPermission();
  if (permission === 'granted') showError({ message: '브라우저 알림을 사용할 수 있습니다.' });
}

function showNewMessageNotification(message) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || document.visibilityState === 'visible') return;
  if (message.senderUid === state.session.uid) return;
  const n = new Notification('새 메신저 메시지', { body: '새 메시지가 도착했어요.', icon: message.senderAvatarUrl || undefined, tag: `messenger-${message.id}` });
  n.onclick = () => { window.focus(); n.close(); };
}

async function handleStreamerVerification(mode) {
  const status = $('#verification-status');
  const note = $('#verification-note');
  const codeButton = $('#verification-note-code');
  status.hidden = false;
  const payload = mode === 'check' ? { checkOnly: true } : mode === 'renew' ? {} : {
    nickname: $('#verification-nickname').value.trim(),
    soopId: $('#verification-soop-id').value.trim(),
  };
  if (mode === 'submit' && (!payload.nickname || !/^[a-z0-9]{2,20}$/.test(payload.soopId))) {
    status.textContent = '닉네임과 SOOP 아이디(영문 소문자/숫자 2~20자)를 확인해주세요.';
    return;
  }
  const previousText = codeButton.textContent.trim();
  const previousCode = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(previousText) ? previousText : '';
  try {
    const result = await api().requestStreamerVerification(payload);
    if (result.action === 'already-verified' || result.action === 'auto-approved') {
      note.hidden = true;
      status.textContent = '스트리머 인증이 완료됐어요. 새로고침하면 방을 만들 수 있습니다.';
      return;
    }
    if (result.action === 'switch') {
      note.hidden = true;
      status.textContent = '기존 인증 계정 전환이 승인됐어요. 원래 계정에서 다시 로그인해주세요.';
      return;
    }
    const canSendNote = result.noteEligible === true || (!result.isSwitch && result.noteEligible !== false);
    note.hidden = !canSendNote;
    status.textContent = result.isSwitch
      ? (canSendNote
        ? '기존 인증 스트리머의 SOOP 아이디로 쪽지 코드를 보내면 확인 후 기존 계정으로 자동 전환됩니다.'
        : '계정 전환 신청은 관리자 수동 확인이 필요합니다.')
      : 'SOOP 쪽지의 발신자 아이디와 코드를 대조해 자동 승인합니다.';
    if (!canSendNote) return;
    const code = Number(result.verificationCodeExpiresAt) > Date.now()
      ? result.verificationCode || (mode === 'check' ? previousCode : '') : '';
    codeButton.textContent = code || '코드 없음';
    codeButton.disabled = !code;
    $('#verification-note-status').textContent = code ? '' : '코드가 없거나 만료됐어요. 새 코드를 발급해주세요.';
    codeButton.onclick = async () => {
      try { await navigator.clipboard.writeText(code); $('#verification-note-status').textContent = '복사했어요. 쪽지 본문에 붙여넣어 보내주세요.'; }
      catch (_) { $('#verification-note-status').textContent = '코드를 선택해 직접 복사해주세요.'; }
    };
  } catch (error) { status.textContent = error.message || '인증 요청을 처리하지 못했습니다.'; }
}

function bindEvents() {
  bindRoomToolControls();
  $('#fan-search').addEventListener('input', () => {
    state.fanSearchQuery = $('#fan-search').value;
    $('#clear-fan-search').hidden = !state.fanSearchQuery;
    renderFans();
  });
  $('#clear-fan-search').addEventListener('click', () => {
    $('#fan-search').value = '';
    state.fanSearchQuery = '';
    $('#clear-fan-search').hidden = true;
    renderFans();
    $('#fan-search').focus();
  });
  $('#timeline').addEventListener('scroll', () => {
    if ($('#timeline').scrollTop <= 36 && state.hasOlderMessages) loadOlderMessages();
  }, { passive: true });
  $('#profile-button').addEventListener('click', openProfile);
  $('#create-room-button').addEventListener('click', openOwnRoom);
  $('#admin-tab-button').addEventListener('click', showAdmin);
  document.querySelectorAll('[data-admin-tab]').forEach((button) => button.addEventListener('click', () => switchAdminTab(button.dataset.adminTab)));
  $('#admin-check-ban').addEventListener('click', checkMessengerBan);
  $('#admin-ban-submit').addEventListener('click', () => setMessengerBan(true));
  $('#admin-unban-submit').addEventListener('click', () => setMessengerBan(false));
  $('#admin-report-status').addEventListener('change', () => loadAdminReportPage(true));
  $('#admin-report-refresh').addEventListener('click', () => loadAdminReportPage(true));
  $('#admin-report-load-more').addEventListener('click', () => loadAdminReportPage(false));
  $('#admin-ban-refresh').addEventListener('click', () => loadAdminBanPage(true));
  $('#admin-ban-load-more').addEventListener('click', () => loadAdminBanPage(false));
  $('#admin-ban-search').addEventListener('input', renderAdminBans);
  $('#report-mark-reviewed').addEventListener('click', () => updateAdminReportStatus('reviewed'));
  $('#report-mark-dismissed').addEventListener('click', () => updateAdminReportStatus('dismissed'));
  $('#report-reopen').addEventListener('click', () => updateAdminReportStatus('pending'));
  $('#close-admin').addEventListener('click', () => { $('#admin-view').hidden = true; $('#directory-view').hidden = false; });
  $('#room-search').addEventListener('input', renderRooms);
  $('#my-rooms-button').addEventListener('click', openMyRoomsDialog);
  $('#close-my-rooms').addEventListener('click', () => closeDialog('my-rooms-dialog'));
  $('#open-mini-game').addEventListener('click', openMiniGameDialog);
  $('#close-mini-game').addEventListener('click', () => closeDialog('mini-game-dialog'));
  $('#mini-game-start').addEventListener('click', () => updateMiniGame('start'));
  $('#mini-game-clear').addEventListener('click', () => updateMiniGame('finish'));
  $('#toggle-mini-game-card').addEventListener('click', () => setMiniGameCollapsed(!state.miniGameCollapsed));
  $('#toggle-room-market').addEventListener('click', () => setRoomMarketCollapsed(!$('#room-market-content').hidden));
  $('#add-room-stock').addEventListener('click', openRoomMarketAddDialog);
  $('#close-room-market-add').addEventListener('click', () => closeDialog('room-market-add-dialog'));
  $('#close-room-market-trade').addEventListener('click', () => closeDialog('room-market-trade-dialog'));
  $('#room-market-search').addEventListener('input', renderRoomMarketSearchResults);
  $('#room-market-buy').addEventListener('click', () => executeRoomMarketTrade('buy'));
  $('#room-market-sell').addEventListener('click', () => executeRoomMarketTrade('sell'));
  $('#back-to-directory').addEventListener('click', leaveChat);
  $('#chat-donation-link').addEventListener('click', openDonationDialog);
  $('#close-donation-dialog').addEventListener('click', () => closeDialog('donation-dialog'));
  $('#donation-notice-button').addEventListener('click', sendDonationNotice);
  $('#export-chat-button').addEventListener('click', openExportDialog);
  $('#export-text').addEventListener('click', () => exportConversation('text'));
  $('#export-image').addEventListener('click', () => exportConversation('image'));
  $('#submit-application').addEventListener('click', submitApplication);
  $('#open-image-picker').addEventListener('click', () => openImagePicker());
  $('#close-image-picker').addEventListener('click', () => closeDialog('image-picker-dialog'));
  $('#close-roomself').addEventListener('click', () => closeDialog('roomself-dialog'));
  $('#roomself-file').addEventListener('change', () => {
    const file = $('#roomself-file').files && $('#roomself-file').files[0]; const preview = $('#roomself-preview'); const button = $('#roomself-send'); const status = $('#roomself-status');
    if (!file) { preview.hidden = true; button.disabled = true; return; }
    if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.type) || file.size > 15 * 1024 * 1024) {
      status.hidden = false; status.textContent = 'JPG, PNG, WebP, GIF 형식의 15MB 이하 이미지를 선택해 주세요.'; button.disabled = true; return;
    }
    status.hidden = true; preview.src = URL.createObjectURL(file); preview.hidden = false; button.disabled = false; button.textContent = '선택한 팬에게 비공개 전송';
  });
  $('#roomself-send').addEventListener('click', uploadAndSendRoomself);
  $('#gallery-inline-upload').addEventListener('click', uploadGalleryImageFromPicker);
  $('#gallery-inline-file').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    $('#gallery-inline-filename').textContent = file ? file.name : '선택한 파일 없음';
    $('#gallery-inline-status').hidden = true;
  });
  $('#send-message').addEventListener('click', () => sendMessage('text'));
  $('#message-input').addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault(); sendMessage('text');
  });
  $('#cancel-reply').addEventListener('click', () => { state.currentReply = null; $('#replying-to').hidden = true; });
  $('#room-settings-button').addEventListener('click', () => { prepareRoomSettings(); openDialog('room-settings-dialog'); });
  $('#room-menu-button').addEventListener('click', openReportDialog);
  $('#submit-report').addEventListener('click', submitReport);
  $('#member-action').addEventListener('click', async () => { if (!state.isOwner || !state.selectedFanUid) return; const ok = window.confirm('이 팬을 차단할까요? 기존 대화는 팬에게 즉시 숨겨지고, 차단 해제 후 다시 신청할 수 있습니다.'); if (!ok) return; try { await call('messengerSetMemberStatus', { roomId: state.room.roomId, uid: state.selectedFanUid, status: 'blocked' }); state.selectedFanUid = ''; $('#member-action').hidden = true; await loadStreamerLists(); renderTimeline(); } catch (error) { showError(error); } });
  $('#save-room-settings').addEventListener('click', saveRoomSettings);
  $('#discard-room').addEventListener('click', discardRoom);
  $('#room-visibility').addEventListener('change', updateRoomPasswordControls);
  $('#regenerate-room-password').addEventListener('click', () => { state.regenerateRoomPassword = !state.regenerateRoomPassword; updateRoomPasswordControls(); });
  $('#copy-room-password').addEventListener('click', copyRoomPassword);
  $('#message-audience').addEventListener('change', () => { $('#direct-recipient').hidden = $('#message-audience').value !== 'direct'; });
  document.querySelectorAll('.aside-tab').forEach((button) => button.addEventListener('click', () => switchAside(button.dataset.listTab)));
  $('#notification-button').addEventListener('click', enableNotifications);
  $('#google-login').addEventListener('click', async () => { try { await api().loginGoogle(); closeDialog('auth-dialog'); } catch (error) { showError(error); } });
  $('#kakao-login').addEventListener('click', async () => { try { await api().loginKakao(); closeDialog('auth-dialog'); } catch (error) { showError(error); } });
  $('#verify-streamer').addEventListener('click', () => { closeDialog('auth-dialog'); openDialog('verification-dialog'); });
  $('#verification-submit').addEventListener('click', () => handleStreamerVerification('submit'));
  $('#verification-check').addEventListener('click', () => handleStreamerVerification('check'));
  $('#verification-renew').addEventListener('click', () => handleStreamerVerification('renew'));
  $('#save-profile').addEventListener('click', saveProfile);
  $('#profile-soop-id').addEventListener('input', updateProfilePreview);
  $('#generic-close').addEventListener('click', () => closeDialog('generic-dialog'));
  $('#generic-cancel').addEventListener('click', () => closeDialog('generic-dialog'));
  $('#report-detail-close').addEventListener('click', () => closeDialog('report-detail-dialog'));
}

function handleSession(event) {
  const previousSession = state.session;
  const previousUid = state.session && state.session.uid;
  state.session = event.detail.session || null;
  const nextUid = state.session && state.session.uid;
  if (previousUid !== nextUid) {
    state.myRooms = []; state.myRoomsUid = ''; state.myRoomsLoaded = false; state.myRoomsPromise = null;
  }
  if (!state.session || !state.session.trusted) {
    state.myRooms = []; state.myRoomsUid = ''; state.myRoomsLoaded = false; state.myRoomsPromise = null;
  }
  if (previousUid !== nextUid) {
    subscribeApplicationResults(); clearOwnerApplicationSubscription();
    state.autoRoomEnsureUid = ''; state.autoRoomEnsurePromise = null;
  }
  if (state.session && state.session.ownRoom) subscribeOwnerApplications(state.session.ownRoom);
  syncHeader();
  if (state.session && state.session.trusted && nextUid && (!state.myRoomsLoaded || state.myRoomsUid !== nextUid)) {
    loadMyRooms().catch((error) => console.warn('참여 중인 채팅방 목록을 불러오지 못했습니다.', error));
  }
  if (state.session && state.session.trusted && state.pendingStreamerRoom) {
    const pendingRoom = state.pendingStreamerRoom;
    state.pendingStreamerRoom = null;
    selectRoom(pendingRoom);
  }
  if (previousSession && !previousSession.isVerifiedStreamer && state.session?.isVerifiedStreamer) {
    const status = $('#verification-status');
    if (status) { status.hidden = false; status.textContent = '✅ 관리자가 승인했어요. 인증 권한이 새로고침 없이 적용됐습니다.'; }
    showToast('스트리머 인증이 승인됐어요.');
  }
  if (state.session && state.session.isVerifiedStreamer && !state.session.ownRoom) {
    ensureVerifiedStreamerRoom();
  }
  if (state.session && state.session.trusted) {
    $('#profile-button').title = '공개 프로필 설정';
    if (state.isOwner && state.room && state.session.ownRoom && state.session.ownRoom.roomId === state.room.roomId) {
      state.room = state.session.ownRoom;
      renderStreamerAvatar($('#chat-avatar'), state.room.streamerAvatarUrl || avatarUrl(state.room.streamerSoopId), state.room.streamerNickname);
      renderRoomState(state.room);
    }
  }
}

let lastFocusSessionRefresh = 0;
let focusSessionRefreshPromise = null;
async function refreshSessionOnReturn() {
  if (document.visibilityState !== 'visible' || !api().auth.currentUser || Date.now() - lastFocusSessionRefresh < 5000) return;
  if (focusSessionRefreshPromise) return focusSessionRefreshPromise;
  lastFocusSessionRefresh = Date.now();
  focusSessionRefreshPromise = api().refreshSession(api().auth.currentUser)
    .catch((error) => console.warn('복귀 시 프로필을 새로고침하지 못했습니다.', error))
    .finally(() => { focusSessionRefreshPromise = null; });
  return focusSessionRefreshPromise;
}

document.addEventListener('messenger-session', handleSession);
window.addEventListener('focus', refreshSessionOnReturn);
document.addEventListener('visibilitychange', refreshSessionOnReturn);
bindEvents();
api().waitForSession().then(() => { state.session = api().state.session; syncHeader(); loadRooms(); });
