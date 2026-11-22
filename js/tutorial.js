// 메신저 체험 튜토리얼(2026-11-16).
// 실제 채팅방과 같은 모양의 연습용 채팅방을 이 화면 안에서만 띄운다.
// 서버 호출·DB 쓰기·로그인 없이 동작하고, 입력한 메시지는 창을 닫으면 사라진다.
// 기기에는 "체험을 끝냈는지"만 localStorage에 남긴다(처음 방문 안내를 다시 띄우지 않기 위함).
const DONE_KEY = 'streamerMessenger.tutorial.v1.done';
const STREAMER = '몽글이';
const FAN = '체험 팬';

const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, className = 'button button-primary', onClick) {
  const b = el('button', className, label);
  b.type = 'button';
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

// 경과 시간 기준 지연(탭이 숨겨져 있으면 setTimeout이 늦어져도 순서는 유지된다).
function later(ms, fn) {
  return window.setTimeout(fn, reduceMotion() ? 0 : ms);
}

const FAN_STEPS = [
  { title: '채팅방 찾기', hint: '참여하고 싶은 스트리머의 채팅방을 눌러 보세요.' },
  { title: '참여 신청', hint: 'SOOP 닉네임·아이디 같은 공개 정보만으로 신청해요. 스트리머가 승인하면 대화할 수 있어요.' },
  { title: '메시지 보내기', hint: '아래 입력창에 하고 싶은 말을 쓰고 ↑ 버튼을 눌러 보세요. 다른 팬의 메시지는 서로 보이지 않아요.' },
  { title: '감정표현', hint: '✦ 감정표현 버튼을 눌러 스티커를 보내 보세요.' },
  { title: '방셀 받기', hint: '스트리머가 나에게만 보낸 사진(방셀)이 도착했어요. 눌러서 열어 보세요.' },
];

const STREAMER_STEPS = [
  { title: '채팅방 열기', hint: '공개방은 목록에 보이고, 비공개방은 비밀번호를 아는 팬만 신청할 수 있어요. 하나를 골라 채팅방을 열어 보세요.' },
  { title: '참여 신청 승인', hint: '팬이 보낸 신청을 확인하고 승인해 보세요. 차단하면 다시 신청할 수 없어요.' },
  { title: '보낼 범위 고르기', hint: '"방 전체"는 모든 팬에게, "팬에게만"은 고른 팬 한 명에게만 보내요. 범위를 고르고 메시지를 보내 보세요.' },
  { title: '고정 메시지', hint: '보낸 메시지의 📌 버튼을 누르면 채팅방 맨 위에 고정돼요.' },
  { title: '방셀 보내기', hint: '＋ 버튼의 방셀로 팬 한 명에게만 사진을 보낼 수 있어요. 받을 팬과 사진을 고르고 보내 보세요. 방셀은 받은 팬만 볼 수 있고 공개 갤러리에 올라가지 않아요.' },
  { title: '미니게임', hint: '🎲 미니게임을 눌러 참여 중인 팬과 사다리타기를 해 보세요.' },
];

let dialog = null;
let timers = [];

function clearTimers() { timers.forEach((t) => window.clearTimeout(t)); timers = []; }
function schedule(ms, fn) { timers.push(later(ms, fn)); }

function markDone() { try { localStorage.setItem(DONE_KEY, '1'); } catch (_) {} }
export function isTutorialDone() { try { return localStorage.getItem(DONE_KEY) === '1'; } catch (_) { return false; } }

function ensureDialog() {
  if (dialog) return dialog;
  dialog = el('dialog', 'app-dialog tutorial-dialog');
  dialog.setAttribute('aria-labelledby', 'tutorial-title');
  dialog.addEventListener('close', clearTimers);
  document.body.appendChild(dialog);
  return dialog;
}

function frame({ step, steps, role }) {
  const card = el('section', 'dialog-card tutorial-card');
  const close = button('×', 'dialog-close', () => dialog.close());
  close.setAttribute('aria-label', '체험 닫기');
  const head = el('header', 'tutorial-head');
  head.append(el('p', 'eyebrow', role === 'fan' ? 'TRY · 팬으로 체험' : 'TRY · 스트리머로 체험'));
  const title = el('h2', '', `${step + 1}. ${steps[step].title}`); title.id = 'tutorial-title';
  head.append(title);
  const progress = el('ol', 'tutorial-progress');
  progress.setAttribute('aria-label', `${steps.length}단계 중 ${step + 1}단계`);
  steps.forEach((_, i) => progress.append(el('li', i < step ? 'done' : i === step ? 'current' : '')));
  const hint = el('p', 'tutorial-hint', steps[step].hint); hint.setAttribute('role', 'status');
  const stage = el('div', 'tutorial-stage');
  const foot = el('footer', 'tutorial-foot');
  foot.append(el('small', 'muted', '연습용 화면이에요 · 실제로 보내지거나 저장되지 않아요'));
  card.append(close, head, progress, hint, stage, foot);
  dialog.replaceChildren(card);
  return { stage, hint, foot };
}

function chatShell(stage, { subtitle, pinnedText = '' } = {}) {
  const shell = el('div', 'tutorial-chat');
  const header = el('div', 'tutorial-chat-header');
  header.append(el('span', 'chat-avatar', '🐑'));
  const titles = el('div', 'tutorial-chat-titles');
  titles.append(el('strong', '', `${STREAMER} 채팅방`), el('small', 'muted', subtitle || '스트리머와 대화해요'));
  header.append(titles);
  const pinned = el('div', 'tutorial-pinned'); pinned.hidden = !pinnedText; pinned.textContent = pinnedText ? `📌 ${pinnedText}` : '';
  const timeline = el('div', 'tutorial-timeline'); timeline.setAttribute('aria-live', 'polite');
  const composer = el('div', 'tutorial-composer');
  shell.append(header, pinned, timeline, composer);
  stage.append(shell);
  return { shell, header, pinned, timeline, composer };
}

function addBubble(timeline, { mine, name, text, node, extraClass = '', avatar = '🐑' }) {
  const row = el('div', `message-row ${mine ? 'fan-message mine' : 'streamer'} tutorial-row ${extraClass}`);
  if (!mine) row.append(el('span', 'message-avatar', avatar));
  const body = el('div', 'tutorial-message-body');
  if (!mine && name) body.append(el('small', 'message-name', name));
  const bubble = el('div', 'message-bubble');
  if (node) bubble.append(node); else bubble.textContent = text;
  body.append(bubble);
  row.append(body);
  timeline.append(row);
  timeline.scrollTop = timeline.scrollHeight;
  return { row, bubble, body };
}

function messageInput(composer, { placeholder = '메시지를 입력하세요', onSend }) {
  const input = el('textarea', 'tutorial-input');
  input.rows = 1; input.maxLength = 200; input.placeholder = placeholder;
  input.setAttribute('aria-label', '연습용 메시지 입력');
  const send = button('↑', 'send-button', () => {
    const value = input.value.trim();
    if (!value) { input.focus(); return; }
    input.value = '';
    onSend(value);
  });
  send.setAttribute('aria-label', '연습용 메시지 보내기');
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send.click(); } });
  composer.append(input, send);
  return { input, send };
}

function nextButton(foot, label, onClick) {
  const b = button(label, 'button button-primary tutorial-next', onClick);
  foot.append(b);
  b.focus();
  return b;
}

// ---------- 팬 체험 ----------
function fanStep(step, ctx = {}) {
  const { stage, foot } = frame({ step, steps: FAN_STEPS, role: 'fan' });
  const go = (n, extra) => fanStep(n, Object.assign({}, ctx, extra));
  if (step === 0) {
    const grid = el('div', 'tutorial-room-grid');
    grid.dataset.tooltipBelow = '';
    [['🐑', STREAMER, '공개방 · 팬 128명', true], ['🦊', '여우비', '비공개방', false], ['🐧', '펭펭', '공개방 · 팬 54명', false]].forEach(([icon, name, sub, target]) => {
      const card = button('', `room-card tutorial-room-card${target ? ' tutorial-target' : ''}`, () => {
        if (!target) { card.classList.add('tutorial-shake'); schedule(400, () => card.classList.remove('tutorial-shake')); return; }
        go(1);
      });
      card.append(el('span', 'tutorial-room-icon', icon), el('strong', '', name), el('small', 'muted', sub));
      card.title = target ? `${name} 채팅방을 열어 봐요` : `연습에서는 ${STREAMER} 채팅방을 골라 주세요`;
      grid.append(card);
    });
    stage.append(grid);
    return;
  }
  if (step === 1) {
    const form = el('div', 'tutorial-form');
    form.append(el('p', 'dialog-copy', `${STREAMER} 채팅방에 참여를 신청해요. 스트리머가 프로필을 확인한 뒤 승인해요.`));
    const profile = el('div', 'tutorial-profile');
    profile.append(el('strong', '', FAN), el('small', 'muted', 'SOOP 아이디 · tryfan (체험용)'));
    form.append(profile);
    const status = el('p', 'tutorial-status');
    const apply = button('참여 신청', 'button button-primary tutorial-target', () => {
      apply.disabled = true;
      status.textContent = '신청했어요. 스트리머의 승인을 기다리는 중…';
      schedule(1400, () => {
        status.textContent = '✅ 승인됐어요! 이제 대화할 수 있어요.';
        nextButton(foot, '채팅방 들어가기', () => go(2));
      });
    });
    form.append(apply, status);
    stage.append(form);
    return;
  }
  const chat = chatShell(stage, { subtitle: '승인된 팬만 대화할 수 있어요' });
  addBubble(chat.timeline, { name: STREAMER, text: '어서 와요! 편하게 이야기해 줘요 :)' });
  (ctx.history || []).forEach((m) => addBubble(chat.timeline, m));
  const remember = (m) => { ctx.history = (ctx.history || []).concat(m); addBubble(chat.timeline, m); };
  if (step === 2) {
    const { input } = messageInput(chat.composer, {
      onSend: (text) => {
        remember({ mine: true, text });
        input.disabled = true;
        schedule(900, () => {
          remember({ name: STREAMER, text: '메시지 잘 받았어요! 이 대화는 나와 스트리머만 볼 수 있어요.' });
          nextButton(foot, '다음', () => go(3, { history: ctx.history }));
        });
      },
    });
    input.classList.add('tutorial-target');
    input.focus();
    return;
  }
  if (step === 3) {
    const picker = el('div', 'tutorial-emote-picker'); picker.hidden = true;
    ['🥰', '👏', '🎉', '🫶'].forEach((emo) => picker.append(button(emo, 'tutorial-emote', () => {
      picker.hidden = true;
      remember({ mine: true, node: el('span', 'tutorial-sticker', emo) });
      schedule(700, () => nextButton(foot, '다음', () => go(4, { history: ctx.history })));
    })));
    const trigger = button('✦ 감정표현', 'emote-trigger tutorial-target', () => { picker.hidden = !picker.hidden; trigger.setAttribute('aria-expanded', String(!picker.hidden)); });
    trigger.setAttribute('aria-expanded', 'false');
    chat.composer.append(trigger, picker);
    return;
  }
  // step 4: 방셀
  const card = el('div', 'tutorial-roomself');
  const open = button('🔒 나에게만 보낸 방셀 · 눌러서 보기', 'tutorial-roomself-cover tutorial-target', () => {
    open.remove();
    card.append(el('div', 'tutorial-roomself-photo', '🐑📸'));
    schedule(600, () => {
      markDone();
      const done = el('div', 'tutorial-done');
      done.append(el('strong', '', '체험 완료!'), el('p', 'dialog-copy', '실제 채팅방도 똑같이 쓰면 돼요. 로그인 후 스트리머 채팅방을 찾아 참여 신청해 보세요. 방셀은 받은 사람만 볼 수 있고 공개 갤러리에 올라가지 않아요.'));
      stage.append(done);
      nextButton(foot, '실제 채팅방 둘러보기', () => dialog.close());
    });
  });
  card.append(open);
  addBubble(chat.timeline, { name: STREAMER, node: card });
}

// ---------- 스트리머 체험 ----------
function streamerStep(step, ctx = {}) {
  const { stage, foot } = frame({ step, steps: STREAMER_STEPS, role: 'streamer' });
  const go = (n, extra) => streamerStep(n, Object.assign({}, ctx, extra));
  if (step === 0) {
    const options = el('div', 'tutorial-choice');
    [['public', '🌐 공개방', '목록에 보이고 누구나 신청'], ['private', '🔒 비공개방', '비밀번호를 아는 팬만 신청']].forEach(([value, label, sub]) => {
      const opt = button('', 'tutorial-choice-option tutorial-target', () => {
        options.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', 'false'));
        opt.setAttribute('aria-pressed', 'true');
        ctx.visibility = value;
        create.disabled = false;
      });
      opt.setAttribute('aria-pressed', 'false');
      opt.append(el('strong', '', label), el('small', 'muted', sub));
      options.append(opt);
    });
    const create = button('채팅방 열기', 'button button-primary', () => go(1, { visibility: ctx.visibility }));
    create.disabled = true;
    stage.append(options, create);
    return;
  }
  if (step === 1) {
    const list = el('div', 'tutorial-requests');
    let approved = 0;
    [['별빛팬', 'starfan'], ['구름이', 'cloudy']].forEach(([name, id]) => {
      const row = el('div', 'tutorial-request');
      const info = el('div', ''); info.append(el('strong', '', name), el('small', 'muted', `SOOP · ${id}`));
      const actions = el('div', 'tutorial-request-actions');
      const ok = button('승인', 'button button-primary tutorial-target', () => {
        actions.replaceChildren(el('span', 'tutorial-badge', '✅ 참여 중'));
        approved += 1;
        ctx.fans = (ctx.fans || []).concat(name);
        if (approved === 1) nextButton(foot, '다음', () => go(2, { fans: ctx.fans }));
      });
      const block = button('차단', 'button button-quiet', () => actions.replaceChildren(el('span', 'tutorial-badge muted', '🚫 차단됨')));
      actions.append(ok, block);
      row.append(info, actions);
      list.append(row);
    });
    stage.append(el('p', 'dialog-copy', ctx.visibility === 'private' ? '비공개방이 열렸어요. 비밀번호는 자동으로 만들어져요.' : '공개방이 열렸어요. 채팅방 목록에 보여요.'), list);
    return;
  }
  const fans = ctx.fans && ctx.fans.length ? ctx.fans : ['별빛팬'];
  const chat = chatShell(stage, { subtitle: `참여 중인 팬 ${fans.length}명`, pinnedText: ctx.pinned || '' });
  (ctx.history || []).forEach((m) => addBubble(chat.timeline, m));
  const remember = (m) => { ctx.history = (ctx.history || []).concat(m); return addBubble(chat.timeline, m); };
  if (step === 2) {
    const options = el('div', 'streamer-compose-options tutorial-compose-options');
    const audience = el('select', 'tutorial-target'); audience.setAttribute('aria-label', '연습용 메시지 수신 범위');
    [['broadcast', '방 전체'], ['direct', '팬에게만']].forEach(([v, l]) => { const o = el('option', '', l); o.value = v; audience.append(o); });
    const recipient = el('select'); recipient.hidden = true; recipient.setAttribute('aria-label', '받을 팬');
    fans.forEach((f) => { const o = el('option', '', f); o.value = f; recipient.append(o); });
    audience.addEventListener('change', () => { recipient.hidden = audience.value !== 'direct'; });
    options.append(audience, recipient);
    chat.shell.insertBefore(options, chat.composer);
    const { input } = messageInput(chat.composer, {
      placeholder: '팬에게 보낼 메시지',
      onSend: (text) => {
        const scope = audience.value === 'direct' ? `${recipient.value}에게만` : '방 전체';
        remember({ mine: true, text: `[${scope}] ${text}`, extraClass: 'tutorial-own-streamer' });
        input.disabled = true;
        schedule(800, () => {
          const from = audience.value === 'direct' ? recipient.value : fans[0];
          remember({ name: from, avatar: '🙋', text: audience.value === 'direct' ? '저한테만 보내주신 거죠? 감동이에요!' : '공지 확인했어요!' });
          nextButton(foot, '다음', () => go(3, { history: ctx.history }));
        });
      },
    });
    input.focus();
    return;
  }
  if (step === 3) {
    const own = (ctx.history || []).filter((m) => m.extraClass === 'tutorial-own-streamer').pop();
    const rows = chat.timeline.querySelectorAll('.tutorial-own-streamer');
    const lastRow = rows[rows.length - 1];
    if (lastRow) {
      const pin = button('📌 고정', 'tutorial-pin tutorial-target', () => {
        chat.pinned.hidden = false;
        chat.pinned.textContent = `📌 ${own ? own.text : ''}`;
        pin.disabled = true;
        ctx.pinned = own ? own.text : '';
        nextButton(foot, '다음', () => go(4, { history: ctx.history, pinned: ctx.pinned }));
      });
      lastRow.querySelector('.tutorial-message-body').append(pin);
    }
    return;
  }
  if (step === 4) {
    // 실제로는 기기에서 사진을 골라 비공개 저장소에 올린다. 체험에서는 예시 사진만 고른다.
    const panel = el('div', 'tutorial-roomself-send');
    const recipient = el('select'); recipient.setAttribute('aria-label', '방셀 받을 팬');
    fans.forEach((f) => { const o = el('option', '', f); o.value = f; recipient.append(o); });
    const photos = el('div', 'tutorial-photo-picks');
    let picked = '';
    ['🌸', '🎧', '🍰'].forEach((emo) => {
      const pick = button(emo, 'tutorial-photo-pick tutorial-target', () => {
        photos.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', 'false'));
        pick.setAttribute('aria-pressed', 'true');
        picked = emo;
        send.disabled = false;
      });
      pick.setAttribute('aria-pressed', 'false');
      pick.setAttribute('aria-label', `예시 사진 ${emo}`);
      photos.append(pick);
    });
    const send = button('방셀 보내기', 'button button-primary', () => {
      send.disabled = true;
      photos.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      const card = el('div', 'tutorial-roomself');
      card.append(el('div', 'tutorial-roomself-photo', picked), el('small', 'muted', `🔒 ${recipient.value}에게만 보냄 · 공개 갤러리에 올라가지 않아요`));
      remember({ mine: true, node: card });
      panel.remove();
      schedule(800, () => {
        remember({ name: recipient.value, avatar: '🙋', text: '방셀 받았어요!! 소중히 볼게요 🥹' });
        nextButton(foot, '다음', () => go(5, { history: ctx.history, pinned: ctx.pinned }));
      });
    });
    send.disabled = true;
    const label = el('label', 'tutorial-roomself-label', '받을 팬 ');
    label.append(recipient);
    panel.append(el('strong', '', '＋ › 방셀 보내기'), label, photos, send);
    chat.shell.insertBefore(panel, chat.composer);
    return;
  }
  // step 5: 미니게임
  const start = button('🎲 미니게임', 'button button-quiet mini-game-trigger tutorial-target', () => {
    start.disabled = true;
    const players = [STREAMER].concat(fans);
    const board = el('div', 'tutorial-ladder');
    players.forEach((p) => board.append(el('span', '', p)));
    remember({ name: STREAMER, node: board });
    schedule(1200, () => {
      const winner = players[players.length > 1 ? 1 : 0];
      remember({ name: '사다리 결과', text: `🎉 ${winner} 당첨!` });
      markDone();
      const done = el('div', 'tutorial-done');
      done.append(el('strong', '', '체험 완료!'), el('p', 'dialog-copy', '인증 스트리머로 로그인하면 실제 채팅방을 열 수 있어요. 대화 관리 버튼(☰)에서 신청 승인·차단, 채팅방 설정을 할 수 있어요.'));
      stage.append(done);
      nextButton(foot, '닫기', () => dialog.close());
    });
  });
  chat.composer.append(start);
}

function chooseRole() {
  ensureDialog();
  const card = el('section', 'dialog-card tutorial-card');
  const close = button('×', 'dialog-close', () => dialog.close());
  close.setAttribute('aria-label', '체험 닫기');
  const title = el('h2', '', '1분 체험해 보기'); title.id = 'tutorial-title';
  const copy = el('p', 'dialog-copy', '실제처럼 눌러 보는 연습용 채팅방이에요. 로그인하지 않아도 되고, 입력한 내용은 저장되거나 전송되지 않아요.');
  const choice = el('div', 'tutorial-choice');
  const fan = button('', 'tutorial-choice-option', () => fanStep(0));
  fan.append(el('strong', '', '🙋 팬으로 체험'), el('small', 'muted', '채팅방 찾기 → 참여 신청 → 대화·스티커 → 방셀'));
  const streamer = button('', 'tutorial-choice-option', () => streamerStep(0));
  streamer.append(el('strong', '', '🎙️ 스트리머로 체험'), el('small', 'muted', '채팅방 열기 → 신청 승인 → 보낼 범위 → 고정 → 방셀 → 미니게임'));
  choice.append(fan, streamer);
  card.append(el('p', 'eyebrow', 'TRY MESSENGER'), close, title, copy, choice);
  dialog.replaceChildren(card);
  if (!dialog.open) dialog.showModal();
  fan.focus();
}

export function openMessengerTutorial() { clearTimers(); chooseRole(); }

export function mountMessengerTutorial() {
  const welcome = document.querySelector('.welcome-copy');
  if (!welcome || document.getElementById('open-tutorial')) return;
  const row = el('div', 'tutorial-entry');
  const open = button(isTutorialDone() ? '체험 다시 해보기' : '처음이라면 1분 체험해 보기', 'button button-primary', openMessengerTutorial);
  open.id = 'open-tutorial';
  row.append(open);
  if (!isTutorialDone()) row.append(el('small', 'muted', '로그인 없이 연습용 채팅방에서 눌러 볼 수 있어요'));
  welcome.append(row);
}
