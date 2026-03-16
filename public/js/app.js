const DEFAULT_REMOTE_API = 'https://tokyo-shinchiku-mansion.onrender.com';
const LS_KEYS = {
  favorites: 'suumo_favorites',
  hidden: 'suumo_hidden',
  notes: 'suumo_notes',
};

const state = {
  apiBase: resolveApiBase(),
  allProperties: [],
  favorites: new Set(JSON.parse(localStorage.getItem(LS_KEYS.favorites) || '[]')),
  hidden: new Set(JSON.parse(localStorage.getItem(LS_KEYS.hidden) || '[]')),
  notes: JSON.parse(localStorage.getItem(LS_KEYS.notes) || '{}'),
  showFavOnly: false,
  sortKey: 'date',
  sortDir: -1,
  prefectureMap: new Map(),
  selectedPrefectures: new Set(),
  selectedTypes: new Set(),
  markerMap: {},
  bounds: null,
  gmap: null,
  infoWindow: null,
  chukoData: [],
  chukoUpdatedAt: '—',
};

function resolveApiBase() {
  const param = new URLSearchParams(location.search).get('api');
  const stored = localStorage.getItem('suumo_api_base');
  const isLocal = /^(localhost|127\.|192\.168\.|10\.|172\.)/.test(location.hostname);
  if (param) return param.replace(/\/$/, '');
  if (stored) return stored.replace(/\/$/, '');
  return isLocal ? location.origin : DEFAULT_REMOTE_API;
}

function persistSet(key, set) { localStorage.setItem(key, JSON.stringify([...set])); }
function persistNotes() { localStorage.setItem(LS_KEYS.notes, JSON.stringify(state.notes)); }
function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function safeId(id) { return id.replace(/[^a-zA-Z0-9_-]/g, '_'); }
function extractPrefecture(address) { const m = (address || '').match(/東京都|大阪府|京都府|北海道|[\u4e00-\u9fff]{2,5}[県]/u); return m ? m[0] : null; }
function isNew(dateStr) { return dateStr && (Date.now() - new Date(dateStr).getTime()) < 3 * 24 * 60 * 60 * 1000; }

async function fetchJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail || body.error || `HTTP ${res.status}`);
  return body;
}

const CHUKO_DATA_URL = new URL('../data/chuko.json', import.meta.url);

async function loadChukoData() {
  const data = await fetchJson(CHUKO_DATA_URL);
  state.chukoUpdatedAt = data.updatedAt || '—';
  state.chukoData = (data.properties || []).map((p, i) => ({
    ...p,
    id: `chuko-${i}`,
    type: 'chuko',
    pubDate: null,
    totalUnits: null,
    line: null,
    busMin: null,
  }));
}

function makeIcon(fill, scale = 1) {
  const w = Math.round(28 * scale), h = Math.round(40 * scale);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 28 40"><path d="M14 0C6.27 0 0 6.27 0 14c0 9.63 14 26 14 26s14-16.37 14-26C28 6.27 21.73 0 14 0z" fill="${fill}" stroke="white" stroke-width="2"/><circle cx="14" cy="14" r="5" fill="white" opacity=".85"/></svg>`;
  return { url:`data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`, scaledSize:new google.maps.Size(w,h), anchor:new google.maps.Point(w/2,h) };
}
function getIcon(id) {
  if (state.favorites.has(id)) return makeIcon('#f59e0b');
  return state.markerMap[id]?.property?.type === 'chuko' ? makeIcon('#4f46e5') : makeIcon('#e8351a');
}

function buildInfoContent(p, geo) {
  const isChuko = p.type === 'chuko';
  const accent = isChuko ? '#4f46e5' : '#e8351a';
  const walk = p.walkMin ? `徒歩${p.walkMin}分` : (p.busMin ? `バス${p.busMin}分` : '');
  const metaParts = [];
  if (p.station) metaParts.push(`${p.station}駅`);
  if (walk) metaParts.push(walk);
  if (!isChuko && p.totalUnits) metaParts.push(`${p.totalUnits}戸`);
  const addrLine = geo.resolvedAddress || geo.address;
  const note = state.notes[p.id] || '';
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;min-width:210px;max-width:280px">
    <div style="display:flex;align-items:center;gap:5px;margin-bottom:6px"><span style="font-size:9px;font-weight:700;padding:2px 6px;border-radius:3px;background:${accent};color:#fff;flex-shrink:0">${isChuko ? '中古' : '新築'}</span><div style="font-size:13px;font-weight:700;color:#111;line-height:1.4">${esc(p.title)}</div></div>
    ${metaParts.length ? `<div style="font-size:12px;color:#6b7280;margin-bottom:5px">${esc(metaParts.join(' · '))}</div>` : ''}
    ${addrLine ? `<div style="font-size:11px;color:#9ca3af;margin-bottom:6px;line-height:1.4">📍 ${esc(addrLine)}</div>` : ''}
    ${note ? `<div style="font-size:11px;color:#374151;margin-bottom:8px">📝 ${esc(note)}</div>` : ''}
    <div style="display:flex;gap:8px;align-items:center"><button onclick="window.toggleFavorite(${JSON.stringify(p.id)})" style="flex-shrink:0;background:none;border:1px solid #e5e7eb;border-radius:7px;padding:6px 10px;font-size:15px;cursor:pointer;line-height:1">${state.favorites.has(p.id) ? '❤️' : '🤍'}</button><a href="${p.link}" target="_blank" style="flex:1;display:block;text-align:center;padding:8px 12px;border-radius:7px;font-size:13px;font-weight:600;text-decoration:none;background:${accent};color:#ffffff;letter-spacing:.2px">物件詳細を見る ↗</a></div>
  </div>`;
}

function addMarker(p, geo) {
  if (state.markerMap[p.id]) { state.markerMap[p.id].marker.setIcon(getIcon(p.id)); return; }
  const marker = new google.maps.Marker({ position:{ lat:geo.lat, lng:geo.lng }, map:state.gmap, icon:getIcon(p.id), title:p.title });
  marker.addListener('click', () => {
    state.infoWindow.setContent(buildInfoContent(p, geo));
    state.infoWindow.open(state.gmap, marker);
  });
  state.markerMap[p.id] = { marker, geo, property: p };
  if (!state.bounds) state.bounds = new google.maps.LatLngBounds();
  state.bounds.extend({ lat: geo.lat, lng: geo.lng });
}

function fitBounds() {
  if (state.bounds && !state.bounds.isEmpty()) {
    state.gmap.fitBounds(state.bounds, 60);
    if (state.gmap.getZoom() > 14) state.gmap.setZoom(14);
  }
}

window.focusMarker = function(id) {
  const entry = state.markerMap[id];
  if (!entry) return;
  state.infoWindow.setContent(buildInfoContent(entry.property, entry.geo));
  state.infoWindow.open(state.gmap, entry.marker);
  state.gmap.panTo({ lat: entry.geo.lat, lng: entry.geo.lng });
  state.gmap.setZoom(15);
  document.getElementById('map-section').scrollIntoView({ behavior:'smooth', block:'nearest' });
};

async function geocodeProperty(p) {
  const params = new URLSearchParams();
  if (p.link) params.set('link', p.link);
  if (p.title) params.set('title', p.title);
  if (p.station) params.set('station', p.station);
  if (p.line) params.set('line', p.line);
  try { return await fetchJson(`${state.apiBase}/api/geocode?${params}`); } catch { return null; }
}

async function geocodeAll(properties) {
  const statusEl = document.getElementById('geocode-status');
  statusEl.style.display = 'block';
  statusEl.textContent = '📍 地図上の位置を取得中…';
  let done = 0, idx = 0;
  const worker = async () => {
    while (idx < properties.length) {
      const p = properties[idx++];
      const geo = await geocodeProperty(p);
      if (geo?.lat) {
        addMarker(p, geo);
        done++;
        statusEl.textContent = `📍 位置取得中 ${done} / ${properties.length}`;
        const pref = extractPrefecture(geo.address);
        if (pref) state.prefectureMap.set(p.id, pref);
        const addrEl = document.getElementById(`addr-${safeId(p.id)}`);
        if (addrEl) {
          addrEl.textContent = (addrEl.dataset.base ? addrEl.dataset.base + ' · ' : '') + (geo.resolvedAddress || geo.address || `${p.station}駅付近`);
          addrEl.style.display = '';
        }
        const pinBtn = document.getElementById(`pin-${safeId(p.id)}`);
        if (pinBtn) pinBtn.classList.remove('no-geo');
      }
    }
  };
  await Promise.allSettled(Array.from({ length: 4 }, worker));
  fitBounds();
  renderPrefectureFilter();
  renderProperties();
  statusEl.textContent = `✅ ${done} 件の位置情報を取得しました`;
  setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
}

function sortedPrefectures(groups) {
  const size = v => Array.isArray(v) ? v.length : (v || 0);
  return [...groups.keys()].sort((a, b) => {
    if (a === '東京都') return -1;
    if (b === '東京都') return 1;
    if (a === '不明') return 1;
    if (b === '不明') return -1;
    return size(groups.get(b)) - size(groups.get(a));
  });
}

function sortProps(props) {
  return [...props].sort((a, b) => {
    let va, vb;
    switch (state.sortKey) {
      case 'title': va = a.title || ''; vb = b.title || ''; return state.sortDir * va.localeCompare(vb, 'ja');
      case 'station': va = a.station || ''; vb = b.station || ''; return state.sortDir * va.localeCompare(vb, 'ja');
      case 'walk': va = a.walkMin || a.busMin || 999; vb = b.walkMin || b.busMin || 999; return state.sortDir * (va - vb);
      case 'units': va = a.totalUnits || 0; vb = b.totalUnits || 0; return state.sortDir * (va - vb);
      case 'date': va = a.pubDate ? new Date(a.pubDate).getTime() : 0; vb = b.pubDate ? new Date(b.pubDate).getTime() : 0; return state.sortDir * (va - vb);
      default: return 0;
    }
  });
}

window.setSort = function(key) {
  if (state.sortKey === key) state.sortDir *= -1;
  else { state.sortKey = key; state.sortDir = key === 'date' ? -1 : 1; }
  renderProperties();
};

function thSort(key, label, extraClass = '') {
  const active = state.sortKey === key;
  const indicator = active ? (state.sortDir === 1 ? '↑' : '↓') : '';
  const th = document.createElement('th');
  th.className = `th-sort${active ? ' sorted' : ''}${extraClass ? ' ' + extraClass : ''}`;
  th.innerHTML = `${label}${indicator ? ` <span class="sort-indicator">${indicator}</span>` : ''}`;
  th.onclick = () => window.setSort(key);
  return th;
}

function renderPrefectureFilter() {
  const bar = document.getElementById('pref-filter');
  const filterBar = document.getElementById('filter-bar');
  const groups = new Map();
  state.allProperties.forEach(p => {
    const pref = state.prefectureMap.get(p.id);
    if (pref) groups.set(pref, (groups.get(pref) || 0) + 1);
  });
  const newCount = state.allProperties.filter(p => p.type !== 'chuko').length;
  const chukoCount = state.allProperties.filter(p => p.type === 'chuko').length;
  filterBar.style.display = 'block';
  bar.innerHTML = '';
  const addToggle = (label, active, onClick, extra='') => {
    const btn = document.createElement('button');
    btn.className = `pref-pill${extra}${active ? ' active' : ''}`;
    btn.innerHTML = label;
    btn.onclick = onClick;
    bar.appendChild(btn);
  };
  addToggle(`❤️ お気に入り <span class="pill-count">${state.favorites.size}</span>`, state.showFavOnly, () => { state.showFavOnly = !state.showFavOnly; renderPrefectureFilter(); renderProperties(); });
  const d1 = document.createElement('span'); d1.className = 'filter-divider'; bar.appendChild(d1);
  addToggle(`新築 <span class="pill-count">${newCount}</span>`, state.selectedTypes.has('new'), () => toggleSet(state.selectedTypes, 'new'), '');
  addToggle(`中古 <span class="pill-count">${chukoCount}</span>`, state.selectedTypes.has('chuko'), () => toggleSet(state.selectedTypes, 'chuko'), ' type-pill-chuko');
  if (groups.size === 0) return;
  const d2 = document.createElement('span'); d2.className = 'filter-divider'; bar.appendChild(d2);
  addToggle('すべて', state.selectedPrefectures.size === 0, () => { state.selectedPrefectures.clear(); renderPrefectureFilter(); renderProperties(); });
  sortedPrefectures(groups).forEach(pref => addToggle(`${esc(pref)} <span class="pill-count">${groups.get(pref)}</span>`, state.selectedPrefectures.has(pref), () => toggleSet(state.selectedPrefectures, pref)));
}

function toggleSet(set, value) {
  if (set.has(value)) set.delete(value); else set.add(value);
  renderPrefectureFilter();
  renderProperties();
}

function syncMarkerVisibility() {
  Object.entries(state.markerMap).forEach(([id, { marker, property }]) => {
    const pref = state.prefectureMap.get(id);
    const prefOk = state.selectedPrefectures.size === 0 || (pref && state.selectedPrefectures.has(pref));
    const favOk = !state.showFavOnly || state.favorites.has(id);
    const typeOk = state.selectedTypes.size === 0 || state.selectedTypes.has(property?.type || 'new');
    const hiddenOk = !state.hidden.has(id);
    const visible = prefOk && favOk && typeOk && hiddenOk;
    marker.setMap(visible ? state.gmap : null);
    if (visible) marker.setIcon(getIcon(id));
  });
}

function buildRow(p) {
  const isChuko = p.type === 'chuko';
  const isFav = state.favorites.has(p.id);
  const sid = safeId(p.id);
  const hasGeo = !!state.markerMap[p.id];
  const walk = p.walkMin ? `徒歩${p.walkMin}分` : (p.busMin ? `バス${p.busMin}分` : '—');
  const dateStr = p.pubDate ? new Date(p.pubDate).toLocaleDateString('ja-JP', { month:'numeric', day:'numeric' }) : '—';
  const subParts = [];
  if (isChuko) {
    if (p.area) subParts.push(`${p.area}㎡`);
    if (p.direction) subParts.push(p.direction);
    if (p.floorInfo) subParts.push(`${p.floorInfo}階`);
    if (p.age) subParts.push(`築${p.age}年`);
    if (p.price) subParts.push(`${p.price}万円`);
  }
  const geo = state.markerMap[p.id]?.geo;
  const addr = geo?.resolvedAddress || geo?.address || '';
  const note = state.notes[p.id] || '';
  const tr = document.createElement('tr');
  tr.id = sid;
  if (isChuko) tr.classList.add('row-chuko'); else tr.classList.add('row-new');
  if (isFav) tr.classList.add('row-fav');
  tr.innerHTML = `
    <td class="col-pin"><button id="pin-${sid}" class="pin-btn${hasGeo ? '' : ' no-geo'}" title="地図で見る" onclick="window.focusMarker(${JSON.stringify(p.id)})">📍</button></td>
    <td class="col-title"><div class="row-title"><span class="type-badge ${isChuko ? 'chuko' : 'new'}">${isChuko ? '中古' : '新築'}</span>${isNew(p.pubDate) ? '<span class="new-badge">NEW</span>' : ''}<a href="${p.link}" target="_blank">${esc(p.title)}</a></div>${subParts.length ? `<div class="row-sub">${esc(subParts.join(' · '))}</div>` : ''}<div class="row-sub" id="addr-${sid}" ${addr ? '' : 'style="display:none"'} data-base="${esc(subParts.join(' · '))}">${addr ? esc(addr) : ''}</div>${note ? `<div class="row-sub">📝 ${esc(note)}</div>` : ''}</td>
    <td class="col-station">${p.station ? esc(p.station) + '駅' : '—'}</td>
    <td class="col-walk">${walk}</td>
    <td class="col-units">${p.totalUnits ? p.totalUnits + '戸' : (isChuko ? p.floorInfo ? `${p.floorInfo}階` : '—' : '—')}</td>
    <td class="col-date">${dateStr}</td>
    <td class="col-actions"><button class="btn-fav" onclick="window.toggleFavorite(${JSON.stringify(p.id)})">${isFav ? '❤️' : '🤍'}</button> <button class="btn-fav" title="隠す" onclick="window.toggleHidden(${JSON.stringify(p.id)})">🙈</button> <button class="btn-fav" title="メモ" onclick="window.editNote(${JSON.stringify(p.id)})">📝</button> <a class="btn-detail" href="${p.link}" target="_blank">詳細 ↗</a></td>`;
  return tr;
}

function renderProperties() {
  const container = document.getElementById('property-grid');
  let visible = [...state.allProperties].filter(p => !state.hidden.has(p.id));
  if (state.showFavOnly) visible = visible.filter(p => state.favorites.has(p.id));
  if (state.selectedTypes.size > 0) visible = visible.filter(p => state.selectedTypes.has(p.type || 'new'));
  if (state.selectedPrefectures.size > 0) visible = visible.filter(p => state.selectedPrefectures.has(state.prefectureMap.get(p.id)));
  container.innerHTML = '';
  const emptyEl = document.getElementById('empty-state');
  if (visible.length === 0) {
    emptyEl.style.display = 'block';
    emptyEl.innerHTML = state.showFavOnly ? '<div class="icon">🤍</div><p>まだお気に入りがありません。<br>❤️ を押して追加してください。</p>' : '<div class="icon">📭</div><p>表示できる物件がありません。</p>';
  } else emptyEl.style.display = 'none';
  const newCnt = state.allProperties.filter(p => p.type !== 'chuko').length;
  const chukoCnt = state.chukoData.length;
  document.getElementById('header-count').textContent = `${newCnt + chukoCnt} 件`;
  document.getElementById('status-text').innerHTML = `<strong>${newCnt}</strong> 件新築 · <strong>${chukoCnt}</strong> 件中古 · <strong>${state.hidden.size}</strong> 件非表示` + (state.favorites.size ? ` <span style="color:#f59e0b">/ ❤️ ${state.favorites.size}</span>` : '');
  const groups = new Map();
  visible.forEach(p => { const pref = state.prefectureMap.get(p.id) || '不明'; if (!groups.has(pref)) groups.set(pref, []); groups.get(pref).push(p); });
  const prefKeys = sortedPrefectures(groups);
  const onlyUnknown = prefKeys.length === 1 && prefKeys[0] === '不明';
  prefKeys.forEach(pref => {
    const props = sortProps(groups.get(pref));
    const section = document.createElement('div'); section.className = 'pref-section';
    if (!onlyUnknown) {
      const hdr = document.createElement('div'); hdr.className = 'pref-header';
      const newInGroup = props.filter(p => p.type !== 'chuko').length;
      const chukoInGroup = props.filter(p => p.type === 'chuko').length;
      hdr.innerHTML = `<span class="pref-name">${esc(pref)}</span><span class="pref-count">${[newInGroup ? `新築 ${newInGroup}件` : '', chukoInGroup ? `中古 ${chukoInGroup}件` : ''].filter(Boolean).join(' · ')}</span>`;
      section.appendChild(hdr);
    }
    const wrapper = document.createElement('div'); wrapper.className = 'table-wrapper';
    const table = document.createElement('table'); table.className = 'property-table';
    const thead = document.createElement('thead'); const headerRow = document.createElement('tr');
    headerRow.appendChild(document.createElement('th')); headerRow.appendChild(thSort('title','物件名')); headerRow.appendChild(thSort('station','最寄駅')); headerRow.appendChild(thSort('walk','徒歩','th-walk')); headerRow.appendChild(thSort('units','階数 / 戸数','th-units')); headerRow.appendChild(thSort('date','登録日','th-date')); headerRow.appendChild(document.createElement('th'));
    thead.appendChild(headerRow); table.appendChild(thead);
    const tbody = document.createElement('tbody'); props.forEach(p => tbody.appendChild(buildRow(p))); table.appendChild(tbody); wrapper.appendChild(table); section.appendChild(wrapper); container.appendChild(section);
  });
  syncMarkerVisibility();
}

window.toggleFavorite = function(id) {
  if (state.favorites.has(id)) state.favorites.delete(id); else state.favorites.add(id);
  persistSet(LS_KEYS.favorites, state.favorites);
  renderPrefectureFilter(); renderProperties();
  if (state.markerMap[id]) { state.markerMap[id].marker.setIcon(getIcon(id)); state.infoWindow.setContent(buildInfoContent(state.markerMap[id].property, state.markerMap[id].geo)); }
};
window.toggleHidden = function(id) { if (state.hidden.has(id)) state.hidden.delete(id); else state.hidden.add(id); persistSet(LS_KEYS.hidden, state.hidden); renderProperties(); };
window.editNote = function(id) { const next = prompt('この物件のメモ', state.notes[id] || ''); if (next === null) return; if (next.trim()) state.notes[id] = next.trim(); else delete state.notes[id]; persistNotes(); renderProperties(); };
window.refreshProperties = function() { Object.values(state.markerMap).forEach(({ marker }) => marker.setMap(null)); Object.keys(state.markerMap).forEach(k => delete state.markerMap[k]); state.prefectureMap.clear(); state.selectedPrefectures.clear(); state.bounds = null; loadProperties(); };

async function loadProperties() {
  document.getElementById('loading-state').style.display = 'block';
  document.getElementById('error-state').style.display = 'none';
  document.getElementById('property-grid').innerHTML = '';
  try {
    const [data] = await Promise.all([fetchJson(`${state.apiBase}/api/properties`), loadChukoData()]);
    state.allProperties = [...(data.properties || []).map(p => ({ ...p, type: 'new' })), ...state.chukoData];
    state.chukoData.forEach(p => state.prefectureMap.set(p.id, '東京都'));
    const fetchedAt = new Date(data.fetchedAt || Date.now());
    const dateTimeStr = fetchedAt.toLocaleDateString('ja-JP', { month:'numeric', day:'numeric' }) + ' ' + fetchedAt.toLocaleTimeString('ja-JP', { hour:'2-digit', minute:'2-digit' });
    document.getElementById('ft-new').textContent = `${dateTimeStr}${data.cache === 'hit' ? ' (cache)' : ''}`;
    document.getElementById('ft-chuko').textContent = `${state.chukoUpdatedAt} (JSON)`;
    document.getElementById('fetch-times').style.display = 'flex';
    document.getElementById('loading-state').style.display = 'none';
    renderPrefectureFilter(); renderProperties(); geocodeAll(state.allProperties);
  } catch (err) {
    document.getElementById('loading-state').style.display = 'none';
    document.getElementById('error-state').style.display = 'block';
    document.getElementById('error-state').querySelector('p').textContent = `⚠️ ${err.message}`;
    console.error(err);
  }
}

window.initMap = function() {
  state.gmap = new google.maps.Map(document.getElementById('map'), { center:{ lat:35.6762, lng:139.6503 }, zoom:11, mapTypeControl:false, streetViewControl:false, fullscreenControl:true, zoomControlOptions:{ position:google.maps.ControlPosition.RIGHT_CENTER } });
  state.infoWindow = new google.maps.InfoWindow({ maxWidth:300 });
  loadProperties();
};

(async () => {
  try {
    const { mapsKey, apiBase } = await fetchJson(`${state.apiBase}/api/config`);
    if (apiBase) state.apiBase = apiBase.replace(/\/$/, '');
    if (!mapsKey) throw new Error('mapsKey missing');
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${mapsKey}&callback=initMap&language=ja&region=JP`;
    s.async = true; s.defer = true;
    document.head.appendChild(s);
  } catch (e) {
    console.error('Failed to load Google Maps:', e.message);
    document.getElementById('map').innerHTML = `<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#6b7280;font-size:14px;flex-direction:column;gap:8px"><span style="font-size:32px">🗺️</span><span>バックエンドサーバーが起動していません</span><span style="font-size:12px">server.js を起動して再試行してください</span></div>`;
  }
})();
