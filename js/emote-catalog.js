const CATALOG_URL = new URL('../catalog/stickers.json', import.meta.url);
const ASSET_ROOT = new URL('https://neezu-crypto.github.io/streamer-game-series-shop/');
let catalogPromise = null;

export function loadMessengerStickerCatalog() {
  if (!catalogPromise) {
    catalogPromise = fetch(CATALOG_URL, { cache: 'no-cache' }).then(async (response) => {
      if (!response.ok) throw new Error('스티커 목록을 불러오지 못했습니다.');
      const catalog = await response.json();
      const stickers = [];
      for (const product of catalog.products || []) {
        const preview = product.preview || {};
        const columns = Math.max(1, Number(preview.columns) || 1);
        const rows = Math.max(1, Number(preview.rows) || 1);
        const assetUrl = new URL(preview.asset || '', ASSET_ROOT);
        if (assetUrl.origin !== ASSET_ROOT.origin || !assetUrl.pathname.startsWith('/streamer-game-series-shop/assets/')) continue;
        for (const [index, sticker] of (Array.isArray(preview.stickers) ? preview.stickers : []).entries()) {
          const column = index % columns;
          const row = Math.floor(index / columns);
          stickers.push({
            id: String(sticker.id || ''),
            productId: String(product.id || ''),
            label: String(sticker.label || '스티커'),
            alt: String(sticker.alt || sticker.label || '스티커'),
            freeForAuthenticated: product.freeForAuthenticated === true,
            asset: assetUrl.href,
            backgroundSize: `${columns * 100}% ${rows * 100}%`,
            backgroundPosition: `${columns === 1 ? 0 : (column / (columns - 1)) * 100}% ${rows === 1 ? 0 : (row / (rows - 1)) * 100}%`,
          });
        }
      }
      return stickers.filter((sticker) => sticker.id && sticker.productId);
    }).catch((error) => {
      catalogPromise = null;
      throw error;
    });
  }
  return catalogPromise;
}

export function applyStickerArt(element, sticker) {
  element.style.backgroundImage = `url("${sticker.asset}")`;
  element.style.backgroundSize = sticker.backgroundSize;
  element.style.backgroundPosition = sticker.backgroundPosition;
}
