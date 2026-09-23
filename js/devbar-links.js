import './firebase-init.js';
import { getDatabase, ref, get } from 'https://www.gstatic.com/firebasejs/12.16.0/firebase-database.js';

const SELF_GAME_ID = 'streamerMessenger';
(async function () {
  try {
    const snapshot = await get(ref(getDatabase(), 'devbarLinks'));
    const data = snapshot.val();
    if (!data) return;
    const links = Object.keys(data)
      .filter((id) => id !== SELF_GAME_ID && data[id] && data[id].url)
      .map((id) => ({ id, ...data[id] }))
      .sort((a, b) => (a.order || 0) - (b.order || 0));
    if (!links.length) return;
    const nav = document.getElementById('devbar-links');
    if (!nav) return;
    nav.querySelectorAll('a[data-game-id]').forEach((node) => node.remove());
    for (const item of links) {
      const link = document.createElement('a');
      link.dataset.gameId = item.id;
      link.href = item.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = item.label || item.name || item.id;
      nav.appendChild(link);
      if (item.id === 'gallery') {
        const unlockLink = document.getElementById('open-gallery-unlock');
        const uploadLink = document.getElementById('upload-to-gallery');
        if (unlockLink) unlockLink.href = item.url;
        if (uploadLink) uploadLink.href = item.url;
      }
    }
  } catch (error) {
    console.error('자매 서비스 링크를 불러오지 못했습니다. 기본 링크를 유지합니다.', error);
  }
})();
