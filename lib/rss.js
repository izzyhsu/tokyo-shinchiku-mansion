export function normalizeFullWidth(str) {
  return str
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

export function parseDescription(desc) {
  const text = normalizeFullWidth((desc || '').replace(/[\t\r]/g, ' ').replace(/\s+/g, ' '));
  const lineMatch    = text.match(/沿線名[：:]\s*(.+?)(?=\s*駅名[：:]|\s*徒歩|\s*バス|\s*総戸数|\s*価格|$)/);
  const stationMatch = text.match(/駅名[：:]\s*(.+?)(?=\s*[-－]\s*|\s*徒歩|\s*バス|\s*総戸数|\s*価格|$)/);
  const walkMatch    = text.match(/徒歩分[：:]徒歩\s*(\d+)\s*分/);
  const busMatch     = text.match(/バス分表示[：:]バス\s*(\d+)\s*分/);
  const unitsMatch   = text.match(/総戸数[：:]\s*(\d+)\s*戸/);
  const priceMatch   = text.match(/価格[：:]\s*([^\s<]+)/);
  return {
    line:       lineMatch    ? lineMatch[1].trim().replace(/[-－\s]+$/, '')    : null,
    station:    stationMatch ? stationMatch[1].trim().replace(/[-－\s]+$/, '') : null,
    walkMin:    walkMatch    ? parseInt(walkMatch[1], 10) : null,
    busMin:     busMatch     ? parseInt(busMatch[1], 10)  : null,
    totalUnits: unitsMatch   ? parseInt(unitsMatch[1], 10): null,
    price:      priceMatch   ? priceMatch[1].trim()       : null,
  };
}
