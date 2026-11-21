//  팬 통계 화면(2026-11-22). 방 주인만 연다. 서버 messengerFanStats가 1시간 캐시된 계산 결과를 1번에 돌려준다.
//  화면에는 닉네임·프로필 사진만 나오고 UID는 받지 않는다. 그래프는 움직이지 않는 SVG로 그린다.

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

export function setupFanStats({ call, getRoom, showToast }) {
  const button = document.getElementById('fan-stats-button');
  const dialog = document.getElementById('fan-stats-dialog');
  const body = document.getElementById('fan-stats-body');
  if (!button || !dialog || !body) return;
  let loading = false;
  let confirmPurchase = false;

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
    const buy = body.querySelector('[data-fs="buy"]');
    if (buy) buy.addEventListener('click', purchase);
  }

  function renderLocked(data) {
    const disabled = !data.enoughData;
    return `
      <section class="fs-locked">
        <h3>상세 통계 · ${fmt(data.passDays || 30)}일 이용권 ${fmt(data.price || 50)}캐시</h3>
        <ul>
          <li>최근 30일 그래프</li><li>자주 대화하는 팬 TOP 20</li><li>새 팬·다시 온 팬 비율</li><li>7일 넘게 조용한 단골</li>
          <li>요일×시간대 표</li><li>강조 메시지 받은 횟수·많이 보낸 팬 TOP 5</li><li>공지 읽음 비율</li><li>이번 달·지난달 비교</li>
        </ul>
        <p class="fine-print">이용권이 없어도 통계는 계속 쌓여요. 사면 지난 기록까지 바로 볼 수 있어요. 다시 사면 남은 기간에 ${fmt(data.passDays || 30)}일이 더해지고, 결제 후에는 환불되지 않아요(결제 오류·이중 차감은 자동 환불).</p>
        <button class="button button-primary full-width" type="button" data-fs="buy" ${disabled ? 'disabled' : ''} title="${disabled ? `참여 팬이 ${fmt(data.minFans || 5)}명 이상일 때 살 수 있어요` : `통합 캐시 ${fmt(data.price || 50)}캐시로 ${fmt(data.passDays || 30)}일 이용권 사기`}">${disabled ? '팬이 더 모이면 살 수 있어요' : `${fmt(data.price || 50)}캐시로 ${fmt(data.passDays || 30)}일 이용하기`}</button>
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
    return `
      <p class="fs-pass">${esc(pass)}${data.freeRoom ? '' : ' · <button type="button" class="text-button" data-fs="buy" title="이용권 30일 연장하기">30일 연장</button>'}</p>
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

  async function purchase(event) {
    const btn = event.currentTarget;
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
      showToast(`팬 통계 이용권이 ${kstDate(result.expiresAt)}까지 켜졌어요 · 남은 캐시 ${fmt(result.remainingCash)}`);
      await load();
    } catch (error) {
      const code = String(error?.code || '');
      if (!code.endsWith('unavailable') && !code.endsWith('deadline-exceeded') && !code.endsWith('internal')) { try { sessionStorage.removeItem(key); } catch (_) {} }
      showToast(error?.message || '결제하지 못했어요. 잠시 후 다시 시도해 주세요.');
      btn.disabled = false; btn.textContent = '다시 시도하기';
    }
  }

  button.addEventListener('click', () => { confirmPurchase = false; dialog.showModal(); void load(); });
}
