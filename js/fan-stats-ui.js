//  팬 통계 화면(2026-11-22). 방 주인만 연다. 서버 messengerFanStats가 1시간 캐시된 계산 결과를 1번에 돌려준다.
//  화면에는 닉네임·프로필 사진만 나오고 UID는 받지 않는다. 그래프는 움직이지 않는 SVG로 그린다.

const CHARGE_URL = 'https://neezu-crypto.github.io/streamer-game-series-shop/customer-center.html#charge';
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n || 0).toLocaleString('ko-KR');
const shortDay = (day) => { const [, m, d] = String(day).split('-'); return `${Number(m)}/${Number(d)}`; };
const kstDate = (at) => new Date(at).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric' });

function delta(now, prev) {
  const diff = Number(now || 0) - Number(prev || 0);
  if (!diff) return '<span class="fs-delta">지난주와 같음</span>';
  const up = diff > 0;
  return `<span class="fs-delta ${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${fmt(Math.abs(diff))} (지난주 ${fmt(prev)})</span>`;
}
function avatar(url, name) {
  return url ? `<img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span>${esc(String(name || '팬').slice(0, 1))}</span>`;
}
function fanRow(item, right, sub) {
  return `<li class="fs-fan"><span class="mini-avatar">${avatar(item.avatarUrl, item.nickname)}</span><span class="fs-fan-name"><strong>${esc(item.nickname)}</strong>${sub ? `<small>${sub}</small>` : ''}</span><b>${right}</b></li>`;
}
function barChart(rows) {
  const max = Math.max(1, ...rows.map((r) => r.messages));
  const w = 600; const h = 150; const gap = 2; const bw = (w - gap * (rows.length - 1)) / rows.length;
  const bars = rows.map((r, i) => {
    const bh = Math.round((r.messages / max) * (h - 20));
    return `<rect x="${(i * (bw + gap)).toFixed(1)}" y="${h - bh}" width="${bw.toFixed(1)}" height="${bh}" rx="2"><title>${shortDay(r.day)} · 메시지 ${fmt(r.messages)} · 팬 ${fmt(r.fans)}명 · 새 팬 ${fmt(r.newFans)}명</title></rect>`;
  }).join('');
  return `<svg class="fs-bars" viewBox="0 0 ${w} ${h + 18}" role="img" aria-label="최근 30일 일별 메시지 수">${bars}<text x="0" y="${h + 15}">${shortDay(rows[0].day)}</text><text x="${w}" y="${h + 15}" text-anchor="end">${shortDay(rows[rows.length - 1].day)}</text></svg>`;
}
function heatmap(grid) {
  const max = Math.max(1, ...grid.flat());
  const head = `<tr><th></th>${Array.from({ length: 24 }, (_, h) => `<th>${h % 3 === 0 ? h : ''}</th>`).join('')}</tr>`;
  const body = [1, 2, 3, 4, 5, 6, 0].map((w) => `<tr><th>${WEEKDAYS[w]}</th>${grid[w].map((v, h) => `<td style="--a:${(v / max).toFixed(2)}" title="${WEEKDAYS[w]}요일 ${h}시 · 메시지 ${fmt(v)}"></td>`).join('')}</tr>`).join('');
  return `<div class="fs-heat-wrap"><table class="fs-heat" aria-label="최근 30일 요일·시간대별 메시지 수">${head}${body}</table></div>`;
}

function shortageBox(price, balance) {
  const need = Math.max(0, Number(price || 0) - Number(balance || 0));
  return `<div class="fs-short" role="status">
      <p><strong>캐시가 ${fmt(need)}캐시 부족해요</strong><br><small>필요 ${fmt(price)}캐시 · 가진 캐시 ${fmt(balance)}캐시 (100원 = 1캐시)</small></p>
      <div class="fs-short-actions">
        <a class="button button-primary" href="${CHARGE_URL}" target="_blank" rel="noopener" title="새 창에서 통합 캐시 충전하기">캐시 충전하기 ↗</a>
        <button type="button" class="button button-quiet" data-fs="recheck" title="충전한 뒤 잔액을 다시 확인하기">충전했어요 · 다시 확인</button>
      </div>
    </div>`;
}

export function setupFanStats({ call, getRoom, showToast }) {
  const button = document.getElementById('fan-stats-button');
  const dialog = document.getElementById('fan-stats-dialog');
  const body = document.getElementById('fan-stats-body');
  if (!button || !dialog || !body) return;
  let loading = false;
  let confirmPurchase = false;
  let lastData = null;
  let pending = null; // 열 때 바로 보여 줄 칸과 옮겨 올 글 { section, text }

  async function load() {
    const room = getRoom();
    if (!room || loading) return;
    loading = true;
    body.innerHTML = '<p class="dialog-copy">통계를 불러오는 중이에요…</p>';
    try {
      const data = (await call('messengerFanStats', { action: 'get', roomId: room.roomId })) || {};
      render(data);
    } catch (error) {
      body.innerHTML = `<p class="dialog-error">${esc(error?.message || '통계를 불러오지 못했어요.')}</p>`;
    } finally { loading = false; }
  }

  function render(data) {
    const f = data.free || {}; const l = f.last7 || {}; const p = f.prev7 || {};
    let html = `
      <div class="fs-cards">
        <div class="fs-card"><small>최근 7일 메시지</small><strong>${fmt(l.messages)}</strong>${delta(l.messages, p.messages)}</div>
        <div class="fs-card"><small>대화한 팬</small><strong>${fmt(l.fans)}명</strong>${delta(l.fans, p.fans)}</div>
        <div class="fs-card"><small>새 팬</small><strong>${fmt(l.newFans)}명</strong>${delta(l.newFans, p.newFans)}</div>
      </div>
      <p class="fine-print">참여 중인 팬 ${fmt(f.totalFans)}명 · ${data.computedAt ? `${new Date(data.computedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} 기준, 1시간마다 새로 계산해요` : ''}</p>`;
    if (!data.enoughData) html += `<p class="fs-note">아직 데이터가 적어요. 참여 팬이 ${fmt(data.minFans || 5)}명 이상이 되면 상세 통계가 의미 있게 보여요.</p>`;
    if (data.unlocked && data.paid) html += renderPaid(data);
    else html += renderLocked(data);
    body.innerHTML = html;
    lastData = data;
    const buy = body.querySelector('[data-fs="buy"]');
    if (buy) buy.addEventListener('click', purchase);
    body.querySelector('[data-fs="recheck"]')?.addEventListener('click', () => { void load(); });
    if (data.unlocked && data.paid) setupSchedule();
    const want = pending; pending = null;
    if (want && want.section === 'schedule') {
      const form = body.querySelector('[data-fs="sched-form"]');
      const target = form ? form.closest('.fs-section') : body.querySelector('.fs-locked');
      if (target) { target.scrollIntoView({ block: 'start' }); target.classList.add('fs-focus'); }
      const area = form && form.querySelector('textarea');
      if (area) { if (want.text && !area.value) area.value = want.text; area.focus({ preventScroll: true }); }
    }
  }

  const STATUS = { pending: '예약됨', sending: '올리는 중', sent: '올림', canceled: '취소함', skipped: '건너뜀' };
  function renderSchedule(items) {
    const box = body.querySelector('[data-fs="sched-list"]'); if (!box) return;
    if (!items.length) { box.innerHTML = '<p class="muted">예약한 공지가 없어요.</p>'; return; }
    box.innerHTML = `<ul class="fs-sched-list">${items.map((n) => `
      <li class="${n.status === 'pending' ? '' : 'done'}"><div><strong>${esc(new Date(n.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' }))}</strong>
        <span class="fs-badge ${esc(n.status)}">${esc(STATUS[n.status] || n.status)}</span>${n.pin ? '<span class="fs-badge">📌 고정</span>' : ''}${n.source ? `<span class="fs-badge">📅 ${esc(n.source.time)} 방송 ${n.source.leadMinutes ? `${n.source.leadMinutes}분 전` : '정각'}</span>` : ''}
        <p>${esc(n.text)}</p>${n.reason ? `<small>${esc(n.reason)}</small>` : ''}</div>
        ${n.status === 'pending' ? `<button type="button" class="text-button" data-cancel="${esc(n.id)}" title="이 예약 취소하기">취소</button>` : ''}</li>`).join('')}</ul>`;
    box.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try { renderSchedule(((await call('messengerScheduledNotices', { action: 'cancel', roomId: getRoom().roomId, id: b.dataset.cancel })) || {}).items || []); showToast('예약을 취소했어요.'); }
      catch (error) { b.disabled = false; showToast(error?.message || '취소하지 못했어요.'); }
    }));
  }
  const WD = ['월', '화', '수', '목', '금', '토', '일'];
  const md = (day) => { const [, m, d] = String(day).split('-'); return `${Number(m)}/${Number(d)}`; };
  const kstAtOf = (day, time) => Date.parse(`${day}T${time}:00+09:00`);
  function setupSchedule() {
    const form = body.querySelector('[data-fs="sched-form"]'); if (!form) return;
    const weekBox = body.querySelector('[data-fs="week"]');
    const text = form.querySelector('textarea'); const when = form.querySelector('input[type="datetime-local"]'); const pin = form.querySelector('input[type="checkbox"]');
    const whenNote = form.querySelector('[data-fs="when"]'); const manualBtn = form.querySelector('[data-fs="manual"]'); const leadBox = form.querySelector('[data-fs="lead"]');
    const local = (at) => new Date(at - new Date(at).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    let weekly = null; let weekIdx = 0; let lastAuto = ''; let picked = null; let manual = false; let items = [];
    const lead = () => Number(form.querySelector('input[name="fs-lead"]:checked')?.value || 30);
    const scheduledKey = (date, time) => items.some((n) => n.status === 'pending' && n.source && n.source.date === date && n.source.time === time);
    function setManual(on) {
      manual = on; when.hidden = !on; when.required = on; leadBox.hidden = on;
      manualBtn.textContent = on ? '일정표에서 고르기' : '직접 날짜 고르기';
      manualBtn.title = on ? '팬페이지 주간 일정표에서 방송을 골라 알리기' : '일정표 대신 날짜와 시각을 직접 고르기';
      manualBtn.hidden = !weekly?.hasAny && on;
      if (on) { picked = null; when.min = local(Date.now() + 11 * 60000); when.max = local(Date.now() + 30 * 86400000); if (!when.value) when.value = local(Date.now() + 60 * 60000); }
      renderWeek(); updateWhen();
    }
    function updateWhen() {
      if (manual) { whenNote.textContent = ''; return; }
      if (!picked) { whenNote.textContent = '일정표에서 알릴 방송을 골라 주세요.'; return; }
      const at = kstAtOf(picked.date, picked.time) - lead() * 60000;
      whenNote.textContent = `${md(picked.date)}(${WD[picked.dayIndex]}) ${picked.time} 방송 → ${new Date(at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}에 올려요`;
    }
    function fillText(day) {
      const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
      const label = day.date === today ? '오늘' : `${md(day.date)}(${WD[day.dayIndex]})`;
      return `${label} ${day.time}${day.content ? ` ${day.content}` : ''} 방송해요! 놀러 오세요`;
    }
    function dayState(day) {
      if (day.offline) return { ok: false, label: '휴방' };
      if (!day.time) return { ok: false, label: day.content ? '시간 미정' : '일정 없음' };
      if (kstAtOf(day.date, day.time) - lead() * 60000 < Date.now() + 10 * 60000) return { ok: false, label: '지남' };
      if (scheduledKey(day.date, day.time)) return { ok: false, label: '예약됨' };
      return { ok: true };
    }
    function renderWeek() {
      if (!weekly) return;
      if (!weekly.hasAny) {
        weekBox.innerHTML = `<p class="fs-note">팬페이지에 주간 일정표가 없어요. <a href="${esc(weekly.fanpageUrl || '#')}" target="_blank" rel="noopener" title="팬페이지에서 주간 일정표 만들기">팬페이지에서 일정표 만들기 ↗</a> · 지금은 날짜를 직접 골라 주세요.</p>`;
        return;
      }
      const w = weekly.weeks[weekIdx];
      const okDays = w.days.filter((d) => dayState(d).ok);
      weekBox.innerHTML = `
        <div class="fs-week-head">
          <button type="button" class="text-button" data-wk="-1" ${weekIdx === 0 ? 'disabled' : ''} title="이번 주 일정 보기">‹ 이번 주</button>
          <strong>${weekIdx === 0 ? '이번 주' : '다음 주'} 일정 <small>${md(w.days[0].date)}~${md(w.days[6].date)} · 팬페이지</small></strong>
          <button type="button" class="text-button" data-wk="1" ${weekIdx === 1 ? 'disabled' : ''} title="다음 주 일정 보기">다음 주 ›</button>
        </div>
        ${w.carriedFrom ? `<p class="fine-print">이 주 일정표가 없어 ${md(w.carriedFrom)} 주 일정표를 이어서 보여 줘요.</p>` : ''}
        <ul class="fs-week-list">${w.days.map((d) => { const st = dayState(d); const on = picked && picked.date === d.date && !manual; return `
          <li class="${on ? 'on' : ''} ${st.ok ? '' : 'off'}"><span class="fs-wd">${WD[d.dayIndex]} <small>${md(d.date)}</small></span>
            <span class="fs-wt">${d.offline ? '휴방' : esc(d.time || '—')}</span><span class="fs-wc">${esc(d.content || '')}</span>
            ${st.ok ? `<button type="button" class="button button-quiet" data-day="${d.dayIndex}" title="${md(d.date)} ${esc(d.time)} 방송 알림 예약하기">${on ? '선택됨' : '알리기'}</button>` : `<span class="fs-badge">${st.label}</span>`}</li>`; }).join('')}</ul>
        ${okDays.length > 1 ? `<button type="button" class="button button-quiet full-width" data-fs="all" title="이 주 남은 방송일 ${okDays.length}개를 같은 설정으로 한 번에 예약하기">이 주 방송 ${okDays.length}개 모두 알리기 (${lead() ? `${lead()}분 전` : '정각'})</button>` : ''}`;
      weekBox.querySelectorAll('[data-wk]').forEach((b) => b.addEventListener('click', () => { weekIdx = Math.max(0, Math.min(1, weekIdx + Number(b.dataset.wk))); renderWeek(); }));
      weekBox.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => {
        const d = w.days[Number(b.dataset.day)]; picked = { ...d, weekStart: w.weekStart };
        if (manual) setManual(false);
        if (!text.value.trim() || text.value === lastAuto) { text.value = fillText(d); lastAuto = text.value; } renderWeek(); updateWhen(); text.focus({ preventScroll: true });
      }));
      weekBox.querySelector('[data-fs="all"]')?.addEventListener('click', async (event) => {
        const btn = event.currentTarget; btn.disabled = true; let done = 0; let lastError = '';
        for (const d of okDays) {
          try { const res = await create({ text: fillText(d), source: { weekStart: w.weekStart, dayIndex: d.dayIndex, leadMinutes: lead() } }); items = res.items || items; done += 1; }
          catch (error) { lastError = error?.message || ''; break; }
        }
        renderSchedule(items); renderWeek();
        showToast(lastError ? `${done}개 예약했어요 · ${lastError}` : `${done}개 방송 알림을 예약했어요.`);
      });
    }
    const create = (payload) => call('messengerScheduledNotices', { action: 'create', roomId: getRoom().roomId, pin: pin.checked, ...payload }).then((r) => r || {});
    leadBox.addEventListener('change', () => { renderWeek(); updateWhen(); });
    manualBtn.addEventListener('click', () => setManual(!manual));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!manual && !picked) { showToast('일정표에서 알릴 방송을 고르거나 직접 날짜를 골라 주세요.'); return; }
      const btn = form.querySelector('button[type="submit"]'); btn.disabled = true;
      try {
        const res = await create(manual ? { text: text.value, at: new Date(when.value).getTime() }
          : { text: text.value, source: { weekStart: picked.weekStart, dayIndex: picked.dayIndex, leadMinutes: lead() } });
        text.value = ''; picked = null; items = res.items || []; renderSchedule(items); renderWeek(); updateWhen(); showToast('공지를 예약했어요.');
      } catch (error) { showToast(error?.message || '예약하지 못했어요.'); }
      finally { btn.disabled = false; }
    });
    call('messengerScheduledNotices', { action: 'list', roomId: getRoom().roomId })
      .then((res) => {
        items = (res || {}).items || []; weekly = (res || {}).weekly || { hasAny: false, weeks: [] };
        renderSchedule(items);
        setManual(!weekly.hasAny);
      })
      .catch((error) => { const box = body.querySelector('[data-fs="sched-list"]'); if (box) box.innerHTML = `<p class="dialog-error">${esc(error?.message || '예약을 불러오지 못했어요.')}</p>`; weekly = { hasAny: false, weeks: [] }; setManual(true); });
  }

  function renderLocked(data) {
    const disabled = !data.enoughData;
    return `
      <section class="fs-locked">
        <h3>스트리머 이용권 · ${fmt(data.passDays || 30)}일 ${fmt(data.price || 50)}캐시</h3>
        <p class="fs-group">📊 팬 통계 상세</p>
        <ul>
          <li>최근 30일 그래프</li><li>자주 대화하는 팬 TOP 20</li><li>새 팬·다시 온 팬 비율</li><li>7일 넘게 조용한 단골</li>
          <li>요일×시간대 표</li><li>강조 메시지 받은 횟수·많이 보낸 팬 TOP 5</li><li>공지 읽음 비율</li><li>이번 달·지난달 비교</li>
        </ul>
        <p class="fs-group">📡 방송 알림 자동 확인</p>
        <ul class="fs-wide"><li>팬이 방을 열지 않아도 방송을 켜면 10분 안에 방에 방송 카드가 올라가요</li></ul>
        <p class="fs-group">⏰ 예약 공지</p>
        <ul class="fs-wide"><li>정한 시각에 공지를 올리고 맨 위에 고정해요 (최대 10개, 30일 안)</li></ul>
        <p class="fine-print">이용권이 없어도 통계는 계속 쌓여요. 사면 지난 기록까지 바로 볼 수 있어요. 다시 사면 남은 기간에 ${fmt(data.passDays || 30)}일이 더해지고, 결제 후에는 환불되지 않아요(결제 오류·이중 차감은 자동 환불).</p>
        ${!disabled && data.balanceCash !== null && data.balanceCash !== undefined && data.balanceCash < (data.price || 50) ? shortageBox(data.price || 50, data.balanceCash) : `
        ${data.balanceCash !== null && data.balanceCash !== undefined ? `<p class="fs-balance">가진 캐시 ${fmt(data.balanceCash)}캐시 → 결제 후 ${fmt(data.balanceCash - (data.price || 50))}캐시</p>` : ''}
        <button class="button button-primary full-width" type="button" data-fs="buy" ${disabled ? 'disabled' : ''} title="${disabled ? `참여 팬이 ${fmt(data.minFans || 5)}명 이상일 때 살 수 있어요` : `통합 캐시 ${fmt(data.price || 50)}캐시로 ${fmt(data.passDays || 30)}일 이용권 사기`}">${disabled ? '팬이 더 모이면 살 수 있어요' : `${fmt(data.price || 50)}캐시로 ${fmt(data.passDays || 30)}일 이용하기`}</button>`}
      </section>`;
  }

  function renderPaid(data) {
    const p = data.paid;
    const nv = p.newVsReturning || {}; const nvTotal = (nv.newFans || 0) + (nv.returningFans || 0);
    const newPct = nvTotal ? Math.round((nv.newFans / nvTotal) * 100) : 0;
    const notice = p.notice || {};
    const noticePct = notice.totalFans ? Math.min(100, Math.round((notice.readCount / notice.totalFans) * 100)) : 0;
    const m = p.monthly || {}; const tm = m.thisMonth || {}; const lm = m.lastMonth || {};
    const pass = data.freeRoom ? '관리자·테스트 방은 무료로 볼 수 있어요.' : `이용권 ${kstDate(data.expiresAt)}까지`;
    const alert = data.broadcastAlerts === 'on' ? '켜짐 · 방송을 켜면 10분 안에 방에 방송 카드가 올라가요'
      : data.broadcastAlerts === 'off' ? '방 설정에서 방송 기록이 꺼져 있어요' : '이 방은 SOOP 방송과 연결되어 있지 않아요';
    return `
      <p class="fs-pass">${esc(pass)}${data.freeRoom ? '' : ' · <button type="button" class="text-button" data-fs="buy" title="이용권 30일 연장하기">30일 연장</button>'}</p>
      <section class="fs-section"><h3>📡 방송 알림 자동 확인</h3><p class="fs-status ${data.broadcastAlerts === 'on' ? 'on' : ''}">${esc(alert)}</p></section>
      <section class="fs-section" data-fs="sched-section"><h3>⏰ 예약 공지</h3>
        <div class="fs-week" data-fs="week"><p class="muted">팬페이지 주간 일정표를 불러오는 중이에요…</p></div>
        <form class="fs-sched-form" data-fs="sched-form">
          <div class="fs-lead" role="radiogroup" aria-label="방송 몇 분 전에 올릴지" data-fs="lead">
            <label title="방송 시작 시각에 올려요"><input type="radio" name="fs-lead" value="0"> 정각</label>
            <label title="방송 30분 전에 올려요"><input type="radio" name="fs-lead" value="30" checked> 30분 전</label>
            <label title="방송 1시간 전에 올려요"><input type="radio" name="fs-lead" value="60"> 1시간 전</label>
          </div>
          <textarea maxlength="1000" rows="3" required placeholder="위 일정표에서 [알리기]를 누르면 문구가 채워져요" aria-label="예약 공지 내용"></textarea>
          <p class="fs-when" data-fs="when" aria-live="polite"></p>
          <div class="fs-sched-row">
            <input type="datetime-local" aria-label="올릴 시각" title="공지를 올릴 시각 (10분 뒤 ~ 30일 안)" hidden>
            <button type="button" class="text-button" data-fs="manual" title="일정표 대신 날짜와 시각을 직접 고르기">직접 날짜 고르기</button>
            <label class="fs-check" title="올리면서 방 맨 위 공지로 고정해요"><input type="checkbox" checked> 공지로 고정</label>
            <button class="button button-primary" type="submit" title="이 시각에 공지 올리기 예약">예약하기</button>
          </div>
        </form>
        <div data-fs="sched-list"><p class="muted">예약을 불러오는 중이에요…</p></div>
      </section>
      <h3 class="fs-divider">📊 팬 통계</h3>
      <section class="fs-section"><h3>최근 30일 메시지</h3>${barChart(p.daily30 || [])}</section>
      <section class="fs-section"><h3>자주 대화하는 팬 TOP 20 <small>최근 30일</small></h3>
        ${(p.top20 || []).length ? `<ol class="fs-fans">${p.top20.map((r) => fanRow(r, `${fmt(r.messages30)}개`, `활동 ${fmt(r.days)}일 · 마지막 ${shortDay(r.lastDay)}`)).join('')}</ol>` : '<p class="muted">최근 30일에 대화한 팬이 없어요.</p>'}</section>
      <section class="fs-section"><h3>새 팬과 다시 온 팬 <small>최근 30일</small></h3>
        <div class="fs-split" title="새 팬 ${fmt(nv.newFans)}명 · 다시 온 팬 ${fmt(nv.returningFans)}명"><span style="width:${newPct}%"></span></div>
        <p class="fine-print">새 팬 ${fmt(nv.newFans)}명 (${newPct}%) · 다시 온 팬 ${fmt(nv.returningFans)}명 (${nvTotal ? 100 - newPct : 0}%)</p></section>
      <section class="fs-section"><h3>7일 넘게 조용한 단골</h3>
        ${(p.quietRegulars || []).length ? `<ul class="fs-fans">${p.quietRegulars.map((r) => fanRow(r, `${fmt(r.total)}개`, `활동 ${fmt(r.days)}일 · 마지막 ${shortDay(r.lastDay)}`)).join('')}</ul>` : '<p class="muted">조용해진 단골이 없어요.</p>'}</section>
      <section class="fs-section"><h3>요일×시간대 <small>최근 30일, 진할수록 메시지가 많아요</small></h3>${heatmap(p.heatmap || Array.from({ length: 7 }, () => Array(24).fill(0)))}</section>
      <section class="fs-section"><h3>강조 메시지 <small>최근 30일 ${fmt(p.highlights?.count30)}개</small></h3>
        ${(p.highlights?.top5 || []).length ? `<ol class="fs-fans">${p.highlights.top5.map((r) => fanRow(r, `${fmt(r.highlights)}번`, '')).join('')}</ol>` : '<p class="muted">아직 강조 메시지가 없어요.</p>'}</section>
      <section class="fs-section"><h3>공지 읽음</h3>
        ${data.hasNotice ? `<div class="fs-split" title="공지를 읽은 팬 ${fmt(notice.readCount)}명"><span style="width:${noticePct}%"></span></div><p class="fine-print">지금 공지를 팬 ${fmt(notice.totalFans)}명 중 ${fmt(notice.readCount)}명이 읽었어요 (${noticePct}%)</p>` : '<p class="muted">지금 올린 공지가 없어요.</p>'}</section>
      <section class="fs-section"><h3>월간 비교</h3>
        <table class="fs-month"><tr><th></th><th>${esc(lm.month || '')}</th><th>${esc(tm.month || '')}</th></tr>
          <tr><th>메시지</th><td>${fmt(lm.messages)}</td><td>${fmt(tm.messages)}</td></tr>
          <tr><th>새 팬</th><td>${fmt(lm.newFans)}</td><td>${fmt(tm.newFans)}</td></tr>
          <tr><th>강조 메시지</th><td>${fmt(lm.highlights)}</td><td>${fmt(tm.highlights)}</td></tr></table></section>`;
  }

  function showShortage(btn, balance) {
    const price = lastData?.price || 50;
    const holder = document.createElement('div'); holder.innerHTML = shortageBox(price, balance);
    const box = holder.firstElementChild;
    body.querySelector('.fs-short')?.remove();
    (btn.closest('.fs-pass') || btn).after(box);
    box.querySelector('[data-fs="recheck"]').addEventListener('click', () => { void load(); });
    box.scrollIntoView({ block: 'nearest' });
  }
  async function purchase(event) {
    const btn = event.currentTarget;
    const bal = lastData?.balanceCash;
    if (bal !== null && bal !== undefined && bal < (lastData?.price || 50)) { showShortage(btn, bal); return; }
    if (!confirmPurchase) {
      confirmPurchase = true;
      btn.textContent = '한 번 더 누르면 결제돼요 (환불 불가)';
      btn.title = '50캐시가 통합 캐시에서 차감돼요';
      setTimeout(() => { confirmPurchase = false; }, 6000);
      return;
    }
    confirmPurchase = false;
    const room = getRoom(); if (!room) return;
    btn.disabled = true; btn.textContent = '결제하는 중…';
    const key = `streamerMessenger.fanStatsPurchase:${room.roomId}`;
    let requestId = '';
    try { requestId = sessionStorage.getItem(key) || ''; } catch (_) {}
    if (!requestId) { const b = new Uint8Array(12); crypto.getRandomValues(b); requestId = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); }
    try { sessionStorage.setItem(key, requestId); } catch (_) {}
    try {
      const result = (await call('messengerFanStats', { action: 'purchase', roomId: room.roomId, requestId })) || {};
      try { sessionStorage.removeItem(key); } catch (_) {}
      showToast(`스트리머 이용권이 ${kstDate(result.expiresAt)}까지 켜졌어요 · 남은 캐시 ${fmt(result.remainingCash)}`);
      await load();
    } catch (error) {
      const code = String(error?.code || '');
      if (!code.endsWith('unavailable') && !code.endsWith('deadline-exceeded') && !code.endsWith('internal')) { try { sessionStorage.removeItem(key); } catch (_) {} }
      if (/부족/.test(String(error?.message || ''))) {
        // 다른 곳에서 캐시를 써서 그사이 잔액이 줄어든 경우. 서버 메시지로 확인하고 최신 잔액을 다시 읽는다.
        try { sessionStorage.removeItem(key); } catch (_) {}
        btn.disabled = false; btn.textContent = `${fmt(lastData?.price || 50)}캐시로 ${fmt(lastData?.passDays || 30)}일 이용하기`;
        await load();
        return;
      }
      showToast(error?.message || '결제하지 못했어요. 잠시 후 다시 시도해 주세요.');
      btn.disabled = false; btn.textContent = '다시 시도하기';
    }
  }

  function open(options = null) { pending = options; confirmPurchase = false; if (!dialog.open) dialog.showModal(); void load(); }
  button.addEventListener('click', () => open());
  // 충전하고 돌아오면(탭이 다시 보이면) 부족 안내가 떠 있을 때만 잔액을 다시 읽는다.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && dialog.open && body.querySelector('.fs-short')) void load(); });
  return { open };
}
