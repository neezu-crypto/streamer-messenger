import './firebase-init.js';

const api = () => window.messenger;
const $ = (selector) => document.querySelector(selector);
const state = { session: null, rooms: [], room: null, isOwner: false, selectedFanUid: '', fans: [], blockedFans: [], applications: [], messages: [], unsubscribers: [], galleryImages: new Map(), imageUrls: new Map(), currentReply: null, activeView: 'directory', seenMessageIds: new Set() };
const dialogs = ['auth-dialog', 'profile-dialog', 'application-dialog', 'room-settings-dialog', 'image-picker-dialog', 'verification-dialog', 'generic-dialog'];
const call = (...args) => api().call(...args);
const escapeText = (v) => String(v == null ? '' : v);

function showError(error, fallback = '요청을 처리하지 못했습니다.') {
  const message = error && error.message ? error.message.replace(/^Firebase: /, '') : fallback;
  window.alert(message || fallback);
}

function avatarUrl(soopId) {
  const id = String(soopId || '').trim().toLowerCase();
  if (!/^[a-z0-9]{2,30}$/.test(id)) return '';
  return `https://stimg.sooplive.com/LOGO/${id.slice(0, 2)}/${id}/${id}.jpg`;
}

function openDialog(id) { const dialog = document.getElementById(id); if (dialog && !dialog.open) dialog.showModal(); }
function closeDialog(id) { const dialog = document.getElementById(id); if (dialog && dialog.open) dialog.close(); }

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
  $('#create-room-button').hidden = !session.isVerifiedStreamer;
  $('#admin-tab-button').hidden = !session.isAdmin;
  if (session.isVerifiedStreamer && session.ownRoom) $('#create-room-button').textContent = '내 채팅방';
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
    if (room.streamerAvatarUrl) { const image = document.createElement('img'); image.src = room.streamerAvatarUrl; image.alt = ''; avatar.appendChild(image); }
    else avatar.textContent = (room.streamerNickname || '✦').slice(0, 1);
    const identity = document.createElement('div'); identity.className = 'room-identity';
    const name = document.createElement('strong'); name.textContent = room.streamerNickname || '스트리머';
    const soopId = document.createElement('small'); soopId.textContent = room.streamerSoopId ? `SOOP ${room.streamerSoopId}` : '스트리머 인증 완료';
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

function loadRooms() {
  const { db, ref, onValue } = api();
  onValue(ref(db, 'streamerMessenger/publicRooms'), (snapshot) => {
    const data = snapshot.val() || {};
    state.rooms = Object.values(data).filter((room) => room && room.roomId).sort((a, b) => String(a.streamerNickname).localeCompare(String(b.streamerNickname), 'ko'));
    renderRooms();
  }, (error) => { console.error('채팅방 목록을 불러오지 못했습니다.', error); $('#room-list').innerHTML = '<div class="loading-card">채팅방 목록을 불러오지 못했어요. 새로고침해 주세요.</div>'; });
}

async function selectRoom(room) {
  if (!state.session || !state.session.trusted) { openDialog('auth-dialog'); return; }
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
}

async function openChat(room, isOwner) {
  state.room = room; state.isOwner = isOwner; state.selectedFanUid = ''; state.currentReply = null;
  $('#directory-view').hidden = true; $('#admin-view').hidden = true; $('#chat-view').hidden = false;
  $('#streamer-aside').hidden = !isOwner;
  $('#member-action').hidden = true;
  $('#chat-title').textContent = isOwner ? '내 채팅방' : `${room.streamerNickname || '스트리머'} 채팅방`;
  $('#chat-subtitle').textContent = isOwner ? '팬별 메시지를 통합 타임라인으로 확인해요' : `SOOP ${room.streamerSoopId || ''} · 나와 스트리머만 보이는 대화`;
  const src = room.streamerAvatarUrl || avatarUrl(room.streamerSoopId);
  $('#chat-avatar').replaceChildren();
  if (src) { const img = document.createElement('img'); img.src = src; img.alt = ''; $('#chat-avatar').appendChild(img); }
  else $('#chat-avatar').textContent = (room.streamerNickname || '✦').slice(0, 1);
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

function clearSubscriptions() { for (const unsubscribe of state.unsubscribers) { try { unsubscribe(); } catch (_) {} } state.unsubscribers = []; }

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

function renderMessage(message) {
  const mine = message.senderUid === state.session.uid;
  const row = document.createElement('article'); row.className = `message-row ${mine ? 'mine' : 'other'}${message.senderRole === 'streamer' ? ' streamer' : ''}`;
  const avatar = document.createElement('div'); avatar.className = 'message-avatar';
  if (message.senderAvatarUrl) { const img = document.createElement('img'); img.src = message.senderAvatarUrl; img.alt = ''; avatar.appendChild(img); }
  else avatar.textContent = (message.senderName || '✦').slice(0, 1);
  const stack = document.createElement('div'); stack.className = 'message-stack';
  if (!mine) { const name = document.createElement('p'); name.className = 'message-name'; name.textContent = message.senderName || '스트리머'; stack.appendChild(name); }
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
    state.fans = fansResult.fans || []; state.blockedFans = state.fans.filter((fan) => fan.status === 'blocked'); state.applications = requestsResult.applications || [];
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
    const meta = document.createElement('span'); meta.className = 'fan-meta'; const name = document.createElement('strong'); name.textContent = application.profile && application.profile.nickname || '팬'; const intro = document.createElement('small'); intro.textContent = application.intro || '소개 없음'; meta.append(name, intro);
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
  if (!state.room) return;
  const text = $('#message-input').value.trim();
  if (kind === 'text' && !text) return;
  const audience = state.isOwner ? $('#message-audience').value : 'direct';
  const recipientUid = state.isOwner ? (audience === 'direct' ? $('#direct-recipient').value : '') : '';
  if (state.isOwner && audience === 'direct' && !recipientUid) { showError({ message: '다이렉트 메시지를 받을 팬을 선택해 주세요.' }); return; }
  const button = $('#send-message'); button.disabled = true;
  try {
    await call('messengerSendMessage', { roomId: state.room.roomId, kind, text, galleryImageId, recipientUid, replyToId: state.currentReply && state.currentReply.id, replyToUid: state.currentReply && state.currentReply.senderUid });
    if (kind === 'text') $('#message-input').value = '';
    state.currentReply = null; $('#replying-to').hidden = true;
  } catch (error) { showError(error); }
  finally { button.disabled = false; }
}

async function openImagePicker() {
  if (!state.room) return;
  $('#gallery-image-list').replaceChildren(); $('#gallery-locked').hidden = true;
  openDialog('image-picker-dialog');
  try {
    const result = await call('messengerGetGalleryImages', { roomId: state.room.roomId });
    if (result.linked === false) { $('#gallery-image-list').innerHTML = '<p class="muted">갤러리 스트리머를 자동으로 연결하지 못했어요. 갤러리의 스트리머 이름과 인증 닉네임이 같은지 확인해 주세요.</p>'; return; }
    if (result.locked) { $('#gallery-locked').hidden = false; $('#gallery-image-list').innerHTML = '<p class="muted">해금 후 이미지를 선택할 수 있어요.</p>'; return; }
    const grid = $('#gallery-image-list'); grid.replaceChildren();
    for (const item of result.images || []) {
      state.galleryImages.set(item.imageId, item);
      const button = document.createElement('button'); button.className = 'gallery-image-button'; button.type = 'button'; button.title = new Date(item.createdAt).toLocaleDateString('ko-KR');
      const img = document.createElement('img'); img.src = item.thumbUrl || item.imageUrl; img.alt = '갤러리 이미지'; img.loading = 'lazy'; button.appendChild(img);
      button.addEventListener('click', async () => { closeDialog('image-picker-dialog'); await sendMessage('image', item.imageId); });
      grid.appendChild(button);
    }
    if (!(result.images || []).length) grid.innerHTML = '<p class="muted">이 스트리머의 갤러리 이미지가 없습니다.</p>';
  } catch (error) { $('#gallery-image-list').textContent = ''; showError(error); }
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
  try {
    const result = await call('messengerEnsureRoom');
    state.session.ownRoom = result.room;
    syncHeader();
    const room = result.room;
    await openChat(room, true);
    if (result.created) openDialog('room-settings-dialog');
  } catch (error) { showError(error); }
}

async function saveRoomSettings() {
  const visibility = $('#room-visibility').value;
  const password = $('#room-password').value;
  try {
    const passwordChanged = visibility === 'private' && password.length > 0;
    const memberPolicy = passwordChanged ? $('#room-member-policy').value : 'keep';
    const result = await call('messengerUpdateRoom', { roomId: state.room.roomId, visibility, password, locked: $('#room-locked').checked, memberPolicy });
    state.room = result.room; renderRoomState(state.room); closeDialog('room-settings-dialog'); $('#room-password').value = '';
  } catch (error) { showError(error); }
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
  try { await call('messengerDiscardRoom', { roomId: state.room.roomId }); await call('messengerEnsureRoom'); closeDialog('room-settings-dialog'); leaveChat(); loadRooms(); showError({ message: '새 채팅방을 만들었습니다. 공개/비공개 설정을 확인해 주세요.' }); }
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
  const nickname = $('#profile-soop-nickname').value.trim(); const soopId = $('#profile-soop-id').value.trim().toLowerCase();
  if (!nickname || !soopId) { showError({ message: 'SOOP 닉네임과 아이디를 입력해 주세요.' }); return; }
  if (nickname.length > 12 || /[<>\x00-\x1f\x7f]/.test(nickname) || !/^[a-z0-9]{2,20}$/.test(soopId)) { showError({ message: '닉네임은 12자 이하, SOOP 아이디는 영문 소문자와 숫자 2~20자로 입력해 주세요.' }); return; }
  try {
    await call('updateGalleryProfile', { nickname, soopId });
    await api().refreshSession(api().auth.currentUser);
    closeDialog('profile-dialog');
  } catch (error) { showError(error); }
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
  $('#submit-application').addEventListener('click', submitApplication);
  $('#open-image-picker').addEventListener('click', openImagePicker);
  $('#close-image-picker').addEventListener('click', () => closeDialog('image-picker-dialog'));
  $('#send-message').addEventListener('click', () => sendMessage('text'));
  $('#message-input').addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage('text'); } });
  $('#cancel-reply').addEventListener('click', () => { state.currentReply = null; $('#replying-to').hidden = true; });
  $('#room-settings-button').addEventListener('click', () => { $('#room-visibility').value = state.room.visibility || 'public'; $('#room-password-wrap').hidden = $('#room-visibility').value !== 'private'; $('#room-locked').checked = state.room.locked === true; $('#room-member-policy').value = 'keep'; $('#room-password').value = ''; openDialog('room-settings-dialog'); });
  $('#room-menu-button').addEventListener('click', async () => { const reason = window.prompt('신고 사유를 입력해 주세요. 신고 범위는 최근 24시간입니다.'); if (reason === null) return; if (state.isOwner && !state.selectedFanUid) { showError({ message: '신고할 팬 대화를 먼저 선택해 주세요.' }); return; } try { const endAt = Date.now(); await call('messengerSubmitReport', { roomId: state.room.roomId, targetUid: state.isOwner ? state.selectedFanUid : undefined, startAt: endAt - 24 * 60 * 60 * 1000, endAt, reason }); showError({ message: '관리자에게 신고를 접수했습니다.' }); } catch (error) { showError(error); } });
  $('#member-action').addEventListener('click', async () => { if (!state.isOwner || !state.selectedFanUid) return; const ok = window.confirm('이 팬을 차단할까요? 기존 대화는 팬에게 즉시 숨겨지고, 차단 해제 후 다시 신청할 수 있습니다.'); if (!ok) return; try { await call('messengerSetMemberStatus', { roomId: state.room.roomId, uid: state.selectedFanUid, status: 'blocked' }); state.selectedFanUid = ''; $('#member-action').hidden = true; await loadStreamerLists(); renderTimeline(); } catch (error) { showError(error); } });
  $('#save-room-settings').addEventListener('click', saveRoomSettings);
  $('#discard-room').addEventListener('click', discardRoom);
  $('#room-visibility').addEventListener('change', () => { $('#room-password-wrap').hidden = $('#room-visibility').value !== 'private'; });
  $('#message-audience').addEventListener('change', () => { $('#direct-recipient').hidden = $('#message-audience').value !== 'direct'; });
  document.querySelectorAll('.aside-tab').forEach((button) => button.addEventListener('click', () => switchAside(button.dataset.listTab)));
  $('#notification-button').addEventListener('click', enableNotifications);
  $('#google-login').addEventListener('click', async () => { try { await api().loginGoogle(); closeDialog('auth-dialog'); } catch (error) { showError(error); } });
  $('#kakao-login').addEventListener('click', async () => { try { await api().loginKakao(); closeDialog('auth-dialog'); } catch (error) { showError(error); } });
  $('#verify-streamer').addEventListener('click', () => { closeDialog('auth-dialog'); openDialog('verification-dialog'); });
  $('#verification-submit').addEventListener('click', async () => { const status = $('#verification-status'); status.hidden = false; try { const result = await api().requestStreamerVerification({ nickname: $('#verification-nickname').value.trim(), soopId: $('#verification-soop-id').value.trim() }); status.textContent = result.action === 'already-verified' ? '이미 인증된 계정입니다.' : '인증 신청을 확인 중입니다. 관리자 승인 후 방을 만들 수 있어요.'; } catch (error) { status.textContent = error.message || '인증 요청을 처리하지 못했습니다.'; } });
  $('#profile-soop-id').addEventListener('input', updateProfilePreview);
  $('#save-profile').addEventListener('click', saveProfile);
  $('#choose-gallery-avatar').addEventListener('click', () => { const link = document.querySelector('#devbar-links a[data-game-id="gallery"]'); window.open(link ? link.href : 'https://streamer-gallery.web.app/', '_blank', 'noopener'); });
  $('#generic-close').addEventListener('click', () => closeDialog('generic-dialog'));
  $('#generic-cancel').addEventListener('click', () => closeDialog('generic-dialog'));
  $('#report-detail-close').addEventListener('click', () => closeDialog('report-detail-dialog'));
}

function handleSession(event) {
  state.session = event.detail.session || null;
  syncHeader();
  if (state.session && state.session.trusted) {
    $('#profile-button').title = '공개 프로필 설정';
    if (state.room && !state.isOwner) { /* 현재 방 유지 */ }
  }
}

document.addEventListener('messenger-session', handleSession);
bindEvents();
api().waitForSession().then(() => { state.session = api().state.session; syncHeader(); loadRooms(); });
