import './firebase-init.js';

const api = () => window.messenger;
const $ = (selector) => document.querySelector(selector);
const state = { session: null, rooms: [], room: null, isOwner: false, selectedFanUid: '', fans: [], blockedFans: [], applications: [], knownApplicationUids: new Set(), applicationStatusUnsubscribers: [], ownerApplicationsUnsubscribe: null, ownerApplicationsRoomId: '', messages: [], unsubscribers: [], messageSending: false, galleryImages: new Map(), galleryStreamerId: '', imageUrls: new Map(), currentReply: null, activeView: 'directory', seenMessageIds: new Set(), regenerateRoomPassword: false };
const dialogs = ['auth-dialog', 'profile-dialog', 'application-dialog', 'room-settings-dialog', 'image-picker-dialog', 'verification-dialog', 'generic-dialog'];
const call = (...args) => api().call(...args);
const escapeText = (v) => String(v == null ? '' : v);
let toastTimer = 0;

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
  if ((session.isVerifiedStreamer || session.isAdmin) && session.ownRoom) $('#create-room-button').textContent = '내 채팅방';
  else $('#create-room-button').textContent = '채팅방 만들기';
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
    const top = document.createElement('div'); top.className = 'room-card-top';
    const avatar = document.createElement('div'); avatar.className = 'room-avatar';
    renderStreamerAvatar(avatar, room.streamerAvatarUrl, room.streamerNickname);
    const identity = document.createElement('div'); identity.className = 'room-identity';
    const name = document.createElement('strong'); name.textContent = room.streamerNickname || '스트리머';
    const soopId = document.createElement('small'); soopId.textContent = room.streamerSoopId ? `SOOP ${room.streamerSoopId}` : (room.roomType === 'admin' ? '관리자 운영' : '스트리머 인증 완료');
    identity.append(name, soopId);
    const lock = document.createElement('span'); lock.className = 'room-lock'; lock.textContent = room.visibility === 'private' ? '🔒' : '◌';
    top.append(avatar, identity, lock);
    const desc = document.createElement('p'); desc.className = 'room-description'; desc.textContent = '스트리머가 신청을 확인한 뒤 대화에 초대해요.';
    const foot = document.createElement('div'); foot.className = 'room-card-foot';
    const badge = document.createElement('span'); badge.className = `room-state-pill${room.visibility === 'private' ? ' private' : ''}${room.locked ? ' locked' : ''}`; badge.textContent = room.locked ? '잠금' : (room.visibility === 'private' ? '비공개방' : '공개방');
    const count = document.createElement('span'); count.textContent = `${room.memberCount || 0}명 참여`;
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
  } catch (error) {
    console.error('채팅방 목록을 불러오지 못했습니다.', error);
    $('#room-list').innerHTML = '<div class="loading-card">채팅방 목록을 불러오지 못했어요. 새로고침해 주세요.</div>';
  }
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
  state.knownApplicationUids = new Set();
  $('#directory-view').hidden = true; $('#admin-view').hidden = true; $('#chat-view').hidden = false;
  $('#streamer-aside').hidden = !isOwner;
  $('#member-action').hidden = true;
  $('#chat-title').textContent = isOwner ? '내 채팅방' : `${room.streamerNickname || '스트리머'} 채팅방`;
  $('#chat-subtitle').textContent = isOwner ? '팬별 메시지를 통합 타임라인으로 확인해요' : (room.roomType === 'admin' ? '나와 관리자만 보이는 대화' : `SOOP ${room.streamerSoopId || ''} · 나와 스트리머만 보이는 대화`);
  const src = room.streamerAvatarUrl || avatarUrl(room.streamerSoopId);
  renderStreamerAvatar($('#chat-avatar'), src, room.streamerNickname);
  renderRoomState(room);
  clearSubscriptions();
  state.galleryImages.clear(); state.imageUrls.clear();
  state.privateMessages = []; state.broadcastMessages = []; state.seenMessageIds = new Set();
  state.notificationsPrimed = false; state.timelineLoaded = { owner: false, private: false, broadcast: false };
  if (isOwner) await loadStreamerLists();
  subscribeTimeline();
  state.activeView = 'chat';
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
}

function subscribeTimeline() {
  clearSubscriptions();
  const { db, ref, onValue, query, orderByKey, limitToLast } = api();
  const roomId = state.room.roomId;
  const render = () => renderTimeline();
  if (state.isOwner) {
    const q = query(ref(db, `streamerMessenger/chat/${roomId}/streamerTimeline`), orderByKey(), limitToLast(100));
    state.unsubscribers.push(onValue(q, (snap) => { state.messages = Object.values(snap.val() || {}); state.timelineLoaded.owner = true; trackNotifications(state.messages); render(); }, showError));
    return;
  }
  const own = ref(db, `streamerMessenger/chat/${roomId}/private/${state.session.uid}`);
  const broadcast = ref(db, `streamerMessenger/chat/${roomId}/broadcast`);
  state.unsubscribers.push(onValue(query(own, orderByKey(), limitToLast(100)), (snap) => { state.privateMessages = Object.values(snap.val() || {}); state.timelineLoaded.private = true; mergeFanMessages(); }, showError));
  state.unsubscribers.push(onValue(query(broadcast, orderByKey(), limitToLast(100)), (snap) => { state.broadcastMessages = Object.values(snap.val() || {}); state.timelineLoaded.broadcast = true; mergeFanMessages(); }, showError));
}

function mergeFanMessages() {
  state.messages = [...(state.privateMessages || []), ...(state.broadcastMessages || [])]
    .filter((m, i, arr) => arr.findIndex((x) => x.id === m.id) === i)
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)).slice(-150);
  trackNotifications(state.messages);
  renderTimeline();
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

function renderTimeline() {
  const host = $('#timeline'); host.replaceChildren();
  let messages = state.messages || [];
  if (state.isOwner && state.selectedFanUid) messages = messages.filter((m) => !m.recipientUid || m.recipientUid === state.selectedFanUid || m.senderUid === state.selectedFanUid);
  messages = [...messages].sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  if (!messages.length) { const empty = document.createElement('div'); empty.className = 'timeline-empty'; empty.textContent = '대화가 시작되면 여기에 표시됩니다.'; host.appendChild(empty); return; }
  for (const message of messages) host.appendChild(renderMessage(message));
  host.scrollTop = host.scrollHeight;
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
  $('#report-reason').value = ''; $('#report-submit-error').hidden = true;
  openDialog('report-submit-dialog');
}

async function submitReport() {
  const error = $('#report-submit-error'); error.hidden = true;
  const startAt = new Date($('#report-start').value).getTime();
  const endAt = new Date($('#report-end').value).getTime();
  const now = Date.now(); const reason = $('#report-reason').value.trim();
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || startAt >= endAt) { error.textContent = '시작·종료 시간을 확인해 주세요.'; error.hidden = false; return; }
  if (startAt < now - 7 * 24 * 60 * 60 * 1000 || endAt > now) { error.textContent = '최근 7일 안의 시간 범위를 선택해 주세요.'; error.hidden = false; return; }
  if (endAt - startAt > 24 * 60 * 60 * 1000) { error.textContent = '신고 범위는 최대 24시간까지 선택할 수 있습니다.'; error.hidden = false; return; }
  if (!reason) { error.textContent = '신고 사유를 입력해 주세요.'; error.hidden = false; return; }
  const submit = $('#submit-report'); submit.disabled = true;
  try {
    const reportData = { roomId: state.room.roomId, startAt, endAt, reason };
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
    const body = message.kind === 'image' ? '[갤러리 이미지 첨부]' : (message.text || '');
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
    const body = message.kind === 'image' ? '[갤러리 이미지 첨부]' : (message.text || '');
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
  } else bubble.textContent = message.text || '';
  stack.appendChild(bubble);
  const meta = document.createElement('div'); meta.className = 'message-meta';
  const time = document.createElement('span'); time.textContent = new Date(message.createdAt || Date.now()).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }); meta.appendChild(time);
  if (state.isOwner && message.senderRole === 'fan') {
    const reply = document.createElement('button'); reply.className = 'reply-action'; reply.type = 'button'; reply.textContent = '답변';
    reply.addEventListener('click', () => setReply(message)); meta.appendChild(reply);
  }
  if (state.isOwner && message.scope === 'direct') { const label = document.createElement('span'); label.className = 'message-kind'; label.textContent = '다이렉트'; meta.appendChild(label); }
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
  all.addEventListener('click', () => { state.selectedFanUid = ''; renderFans(); renderTimeline(); }); host.appendChild(all);
  for (const fan of activeFans) {
    const button = document.createElement('button'); button.type = 'button'; button.className = `fan-item${state.selectedFanUid === fan.uid ? ' active' : ''}`;
    const avatar = document.createElement('span'); avatar.className = 'mini-avatar';
    if (fan.profile.avatarUrl) { const img = document.createElement('img'); img.src = fan.profile.avatarUrl; img.alt = ''; avatar.appendChild(img); } else avatar.textContent = (fan.profile.nickname || '✦').slice(0, 1);
    const meta = document.createElement('span'); meta.className = 'fan-meta'; const name = document.createElement('strong'); name.textContent = fan.profile.nickname || '팬'; const id = document.createElement('small'); id.textContent = fan.profile.soopId ? `SOOP ${fan.profile.soopId}` : '팬'; meta.append(name, id); button.append(avatar, meta);
    button.addEventListener('click', () => { state.selectedFanUid = fan.uid; $('#member-action').hidden = false; $('#member-action').textContent = '차단'; renderFans(); renderTimeline(); }); host.appendChild(button);
  }
}

function renderBlockedFans() {
  const host = $('#blocked-list'); host.replaceChildren();
  if (!state.blockedFans.length) { host.textContent = '차단된 팬이 없습니다.'; host.className = 'fan-list muted'; return; }
  host.className = 'fan-list';
  for (const fan of state.blockedFans) {
    const row = document.createElement('div'); row.className = 'fan-item';
    const meta = document.createElement('span'); meta.className = 'fan-meta'; const name = document.createElement('strong'); name.textContent = fan.profile.nickname || '팬'; const id = document.createElement('small'); id.textContent = fan.profile.soopId ? `SOOP ${fan.profile.soopId}` : '차단됨'; meta.append(name, id);
    const unblock = document.createElement('button'); unblock.type = 'button'; unblock.className = 'text-button'; unblock.textContent = '해제'; unblock.addEventListener('click', async () => { try { await call('messengerSetMemberStatus', { roomId: state.room.roomId, uid: fan.uid, status: 'active' }); await loadStreamerLists(); } catch (error) { showError(error); } });
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
    for (const [decision, label] of [['approved', '승인'], ['rejected', '거절']]) { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; if (decision === 'rejected') button.className = 'reject'; button.addEventListener('click', async () => { try { await call('messengerReviewApplication', { roomId: state.room.roomId, uid: application.uid, decision }); await loadStreamerLists(); } catch (error) { showError(error); } }); actions.appendChild(button); }
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

async function sendMessage(kind = 'text', galleryImageId = '') {
  if (!state.room || !state.session) return;
  const text = $('#message-input').value.trim();
  if (kind === 'text' && !text) return;
  const audience = state.isOwner ? $('#message-audience').value : 'direct';
  const recipientUid = state.isOwner ? (audience === 'direct' ? $('#direct-recipient').value : '') : '';
  if (state.isOwner && audience === 'direct' && !recipientUid) { showError({ message: '다이렉트 메시지를 받을 팬을 선택해 주세요.' }); return; }
  const room = state.room;
  const uid = state.session.uid;
  const isOwner = state.isOwner;
  const reply = state.currentReply;
  const messageId = api().push(api().ref(api().db, `streamerMessenger/chat/${room.roomId}/streamerTimeline`)).key;
  const senderProfile = isOwner
    ? { nickname: room.streamerNickname || '스트리머', avatarUrl: room.streamerAvatarUrl || '' }
    : (state.session.profile || {});
  const message = {
    id: messageId, roomId: room.roomId, senderUid: uid,
    senderRole: isOwner ? 'streamer' : 'fan', senderName: senderProfile.nickname || (isOwner ? '스트리머' : '팬'),
    senderAvatarUrl: senderProfile.avatarUrl || '', createdAt: Date.now(), recipientUid: recipientUid || null,
    kind, ...(kind === 'image' ? { galleryImageId } : { text }),
    scope: isOwner ? (recipientUid ? (reply && reply.id ? 'reply' : 'direct') : 'broadcast') : 'fan', pending: true,
    ...(reply && reply.id ? { replyToId: reply.id, replyToUid: reply.senderUid } : {}),
  };
  state.messages = [...state.messages, message];
  renderTimeline();
  if (kind === 'text') $('#message-input').value = '';
  state.currentReply = null; $('#replying-to').hidden = true;
  try {
    await call('messengerSendMessage', { roomId: room.roomId, clientMessageId: messageId, kind, text, galleryImageId, recipientUid, replyToId: reply && reply.id, replyToUid: reply && reply.senderUid });
    if (state.room && state.room.roomId === room.roomId) {
      const optimistic = state.messages.find((item) => item.id === messageId);
      if (optimistic) { optimistic.pending = false; renderTimeline(); }
    }
  } catch (error) {
    if (state.room && state.room.roomId === room.roomId) {
      state.messages = state.messages.filter((item) => item.id !== messageId);
      if (kind === 'text' && !$('#message-input').value) $('#message-input').value = text;
      renderTimeline();
    }
    showError(error);
  }
}

async function openImagePicker() {
  if (!state.room) return;
  $('#gallery-image-list').replaceChildren(); $('#gallery-locked').hidden = true;
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
      button.addEventListener('click', async () => { closeDialog('image-picker-dialog'); await sendMessage('image', item.imageId); });
      grid.appendChild(button);
    }
    if (!images.length) grid.innerHTML = '<p class="muted">이 스트리머 갤러리에 등록된 사진이 아직 없습니다.</p>';
  } catch (error) { $('#gallery-image-list').textContent = ''; showError(error); }
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
    await call('registerImage', {
      imageId: prepared.imageId, key: prepared.key, thumbKey: prepared.thumbKey,
      streamerId, streamerName,
      category: $('#gallery-inline-category').value, width: thumb.width, height: thumb.height,
    });
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
    const result = await call('messengerUpdateRoom', { roomId: state.room.roomId, visibility, regeneratePassword: state.regenerateRoomPassword, locked: $('#room-locked').checked, memberPolicy: $('#room-member-policy').value });
    state.room = result.room; state.regenerateRoomPassword = false; renderRoomState(state.room); upsertRoom(result.room);
    if (result.generatedPassword) {
      $('#generated-room-password').value = result.generatedPassword;
      $('#generated-password-wrap').hidden = false;
      $('#room-password-copy-status').textContent = '비밀번호를 복사해 팬에게 전달하세요. 이 창을 닫으면 다시 확인할 수 없습니다.';
      $('#room-password-copy-status').hidden = false;
      $('#room-visibility').disabled = true; $('#room-locked').disabled = true; $('#room-member-policy').disabled = true; $('#regenerate-room-password').disabled = true;
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
  $('#room-member-policy').value = 'keep';
  $('#room-visibility').disabled = false; $('#room-locked').disabled = false; $('#room-member-policy').disabled = false; $('#regenerate-room-password').disabled = false;
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

function leaveChat() { clearSubscriptions(); state.room = null; state.activeView = 'directory'; $('#chat-view').hidden = true; $('#directory-view').hidden = false; }

function switchAside(tab) {
  document.querySelectorAll('.aside-tab').forEach((button) => button.classList.toggle('active', button.dataset.listTab === tab));
  $('#fan-list').hidden = tab !== 'fans'; $('#request-list').hidden = tab !== 'requests';
  $('#blocked-list').hidden = tab !== 'blocked';
}

async function showAdmin() {
  if (!state.session || !state.session.isAdmin) return;
  leaveChat(); $('#directory-view').hidden = true; $('#admin-view').hidden = false;
  const host = $('#admin-report-list'); host.textContent = '신고 목록을 불러옵니다.';
  try {
    const result = await call('messengerAdminGetDashboard'); host.replaceChildren();
    if (!result.reports.length) { host.textContent = '대기 중인 신고가 없습니다.'; return; }
    for (const report of result.reports) {
      const card = document.createElement('article'); card.className = 'admin-report-card';
      const copy = document.createElement('div'); const title = document.createElement('strong'); title.textContent = `신고 · ${report.status || 'pending'}`; const meta = document.createElement('p'); meta.textContent = `${new Date(report.createdAt).toLocaleString('ko-KR')} · ${report.reason || '사유 없음'}`; const detail = document.createElement('p'); detail.textContent = `범위: ${new Date(report.rangeStart).toLocaleString('ko-KR')} – ${new Date(report.rangeEnd).toLocaleString('ko-KR')}`; copy.append(title, meta, detail);
      const actions = document.createElement('div'); actions.className = 'report-actions';
      const evidenceButton = document.createElement('button'); evidenceButton.type = 'button'; evidenceButton.textContent = '대화 보기'; evidenceButton.addEventListener('click', async () => { try { await showReportEvidence(report.id); } catch (error) { showError(error); } }); actions.appendChild(evidenceButton);
      for (const [status, label] of [['reviewed', '확인'], ['dismissed', '기각']]) { const button = document.createElement('button'); button.type = 'button'; button.textContent = label; if (status === 'dismissed') button.className = 'danger'; button.addEventListener('click', async () => { try { await call('messengerAdminUpdateReport', { reportId: report.id, status }); await showAdmin(); } catch (error) { showError(error); } }); actions.appendChild(button); }
      card.append(copy, actions); host.appendChild(card);
    }
  } catch (error) { host.textContent = error.message || '신고 목록을 불러오지 못했습니다.'; }
}

async function showReportEvidence(reportId) {
  const result = await call('messengerAdminGetReportDetail', { reportId });
  const host = $('#report-evidence-list'); host.replaceChildren();
  for (const message of result.evidence || []) {
    const row = document.createElement('article'); row.className = 'report-evidence-item';
    const label = document.createElement('small'); label.textContent = `${message.senderName || '사용자'} · ${new Date(message.createdAt || 0).toLocaleString('ko-KR')}`;
    const body = document.createElement('p'); body.textContent = message.kind === 'image' ? `갤러리 이미지 첨부 (${message.galleryImageId})` : (message.text || '');
    row.append(label, body); host.appendChild(row);
  }
  if (!host.children.length) host.textContent = '보관된 대화 증거가 없습니다.';
  openDialog('report-detail-dialog');
}

function updateProfilePreview() {
  const src = avatarUrl($('#profile-soop-id').value);
  const image = $('#profile-avatar-preview'); const fallback = $('#avatar-fallback');
  image.hidden = !src; fallback.hidden = !!src;
  if (src) image.src = src;
}

function openProfile() {
  if (!state.session || !state.session.trusted) { openDialog('auth-dialog'); return; }
  const profile = state.session.profile || {};
  $('#profile-soop-nickname').value = profile.nickname || (state.session.streamer && state.session.streamer.nickname) || '';
  $('#profile-soop-id').value = profile.soopId || (state.session.streamer && state.session.streamer.soopId) || '';
  updateProfilePreview(); openDialog('profile-dialog');
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

function bindEvents() {
  $('#profile-button').addEventListener('click', openProfile);
  $('#create-room-button').addEventListener('click', openOwnRoom);
  $('#admin-tab-button').addEventListener('click', showAdmin);
  $('#close-admin').addEventListener('click', () => { $('#admin-view').hidden = true; $('#directory-view').hidden = false; });
  $('#room-search').addEventListener('input', renderRooms);
  $('#back-to-directory').addEventListener('click', leaveChat);
  $('#export-chat-button').addEventListener('click', openExportDialog);
  $('#export-text').addEventListener('click', () => exportConversation('text'));
  $('#export-image').addEventListener('click', () => exportConversation('image'));
  $('#submit-application').addEventListener('click', submitApplication);
  $('#open-image-picker').addEventListener('click', openImagePicker);
  $('#close-image-picker').addEventListener('click', () => closeDialog('image-picker-dialog'));
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
  $('#verification-submit').addEventListener('click', async () => { const status = $('#verification-status'); status.hidden = false; try { const result = await api().requestStreamerVerification({ nickname: $('#verification-nickname').value.trim(), soopId: $('#verification-soop-id').value.trim() }); status.textContent = result.action === 'already-verified' ? '이미 인증된 계정입니다.' : '인증 신청을 확인 중입니다. 관리자 승인 후 방을 만들 수 있어요.'; } catch (error) { status.textContent = error.message || '인증 요청을 처리하지 못했습니다.'; } });
  $('#profile-soop-id').addEventListener('input', updateProfilePreview);
  $('#save-profile').addEventListener('click', saveProfile);
  $('#choose-gallery-avatar').addEventListener('click', () => { const link = document.querySelector('#devbar-links a[data-game-id="gallery"]'); window.open(link ? link.href : 'https://neezu-crypto.github.io/streamer-gallery/', '_blank', 'noopener'); });
  $('#generic-close').addEventListener('click', () => closeDialog('generic-dialog'));
  $('#generic-cancel').addEventListener('click', () => closeDialog('generic-dialog'));
  $('#report-detail-close').addEventListener('click', () => closeDialog('report-detail-dialog'));
}

function handleSession(event) {
  const previousUid = state.session && state.session.uid;
  state.session = event.detail.session || null;
  const nextUid = state.session && state.session.uid;
  if (previousUid !== nextUid) {
    subscribeApplicationResults(); clearOwnerApplicationSubscription();
  }
  if (state.session && state.session.ownRoom) subscribeOwnerApplications(state.session.ownRoom);
  syncHeader();
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
