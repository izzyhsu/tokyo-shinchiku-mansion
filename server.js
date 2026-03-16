import express from 'express';
import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 3001;

const GOOGLE_MAPS_BROWSER_KEY = process.env.GOOGLE_MAPS_BROWSER_KEY || '';
const GOOGLE_MAPS_SERVER_KEY  = process.env.GOOGLE_MAPS_SERVER_KEY || '';
if (!GOOGLE_MAPS_BROWSER_KEY) console.warn('⚠️  GOOGLE_MAPS_BROWSER_KEY not set');
if (!GOOGLE_MAPS_SERVER_KEY)  console.warn('⚠️  GOOGLE_MAPS_SERVER_KEY not set');

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Persistent geocode cache ───────────────────────────────────────────────────
const GEOCACHE_FILE = path.join(__dirname, 'geocache.json');
let geocache = {};
try { geocache = JSON.parse(fs.readFileSync(GEOCACHE_FILE, 'utf8')); } catch {}

function saveGeocache() {
  try { fs.writeFileSync(GEOCACHE_FILE, JSON.stringify(geocache, null, 2)); } catch (e) {
    console.warn('Could not save geocache:', e.message);
  }
}

console.log(`📦 Geocache loaded: ${Object.keys(geocache).length} entries`);

// ── Server-side Google API calls ───────────────────────────────────────────────
async function googleGeocode(address) {
  try {
    const res = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: { address, key: GOOGLE_MAPS_SERVER_KEY, region: 'jp', language: 'ja' },
      timeout: 6000,
    });
    const hit = res.data?.results?.[0];
    if (hit) return {
      lat:     hit.geometry.location.lat,
      lng:     hit.geometry.location.lng,
      address: hit.formatted_address,
    };
  } catch (err) { console.warn('Geocode API error:', err.message); }
  return null;
}

async function googlePlacesSearch(query) {
  try {
    const res = await axios.get('https://maps.googleapis.com/maps/api/place/textsearch/json', {
      params: { query, key: GOOGLE_MAPS_SERVER_KEY, language: 'ja', region: 'jp' },
      timeout: 6000,
    });
    const hit = res.data?.results?.[0];
    if (hit) return {
      lat:     hit.geometry.location.lat,
      lng:     hit.geometry.location.lng,
      address: hit.formatted_address || hit.vicinity || hit.name,
    };
  } catch (err) { console.warn('Places API error:', err.message); }
  return null;
}

// ── SUUMO address scraper ──────────────────────────────────────────────────────
async function scrapePropertyAddress(url) {
  try {
    const res = await axios.get(url, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept-Language': 'ja,en;q=0.9',
        'Referer':         'https://suumo.jp/',
      },
      timeout: 10000,
      responseType: 'text',
    });
    const patterns = [
      /所在地<\/th>\s*<td[^>]*>\s*(?:<[^>]+>)?([^<]{5,})/,
      /所在地<\/dt>\s*<dd[^>]*>\s*(?:<[^>]+>)?([^<]{5,})/,
      /"address"\s*[^>]*>([^<]{5,})/,
      /所在地[^<]*<[^>]+>([^<]{5,})/,
    ];
    for (const pat of patterns) {
      const m = res.data.match(pat);
      if (m) {
        const addr = m[1].trim().replace(/\s+/g, '').replace(/&amp;/g, '&');
        if (addr.length >= 5 && /[都道府県区市町村]/.test(addr)) return addr;
      }
    }
  } catch (err) { console.warn(`Scrape failed for ${url}: ${err.message}`); }
  return null;
}

// ── Routes ─────────────────────────────────────────────────────────────────────

app.get('/api/config', (req, res) => {
  res.json({ mapsKey: GOOGLE_MAPS_BROWSER_KEY });
});

// Unified geocode endpoint — cache-first, full fallback chain
app.get('/api/geocode', async (req, res) => {
  const { link, title, station, line } = req.query;
  const cacheKey = link || title;
  if (!cacheKey) return res.json(null);

  // ── Cache hit ────────────────────────────────────────────────────────────────
  if (geocache[cacheKey] !== undefined) {
    console.log(`  📦 Cache hit: ${title || link}`);
    return res.json(geocache[cacheKey]);
  }

  console.log(`  🔍 Geocoding new entry: ${title || link}`);
  let result = null;

  // 1. Scrape 所在地 from SUUMO detail page → Geocoding API
  if (link) {
    const address = await scrapePropertyAddress(link);
    if (address) {
      const geo = await googleGeocode(address);
      if (geo) {
        result = { ...geo, resolvedAddress: address, source: 'address' };
        console.log(`    ✅ address: ${address}`);
      }
    }
  }

  // 2. Google Places Text Search by property name
  if (!result && title) {
    const geo = await googlePlacesSearch(title)
             || await googlePlacesSearch(`${title} ${station ? station + '駅' : ''}`.trim());
    if (geo) {
      result = { ...geo, source: 'places' };
      console.log(`    ✅ places: ${geo.address}`);
    }
  }

  // 3. Station name fallback
  if (!result && station) {
    const geo = await googleGeocode(`${station}駅`)
             || (line ? await googleGeocode(`${line} ${station}駅`) : null);
    if (geo) {
      result = { ...geo, source: 'station' };
      console.log(`    ✅ station fallback: ${station}駅`);
    }
  }

  // Persist to cache (including null so we don't retry failed lookups)
  geocache[cacheKey] = result;
  saveGeocache();

  res.json(result);
});

// ── RSS feed ───────────────────────────────────────────────────────────────────
const RSS_BASE    = 'https://suumo.jp/jj/bukken/ichiran/JJ011FC001/?ar=030&bs=010&nf=010001&rssFlg=1';
const RSS_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept':          'application/rss+xml, application/xml, text/xml, */*',
  'Accept-Language': 'ja,en;q=0.9',
  'Referer':         'https://suumo.jp/',
};
const rssParser = new XMLParser({
  ignoreAttributes: false, parseTagValue: true, trimValues: true, cdataPropName: '__cdata',
});

function normalizeFullWidth(str) {
  return str
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

function parseDescription(desc) {
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
    walkMin:    walkMatch    ? parseInt(walkMatch[1]) : null,
    busMin:     busMatch     ? parseInt(busMatch[1])  : null,
    totalUnits: unitsMatch   ? parseInt(unitsMatch[1]): null,
    price:      priceMatch   ? priceMatch[1].trim()   : null,
  };
}

async function fetchRssPage(page) {
  const url = page === 1 ? RSS_BASE : `${RSS_BASE}&pn=${page}`;
  const res = await axios.get(url, { headers: RSS_HEADERS, timeout: 15000, responseType: 'text' });
  const parsed   = rssParser.parse(res.data);
  const rawItems = parsed?.rss?.channel?.item || [];
  return Array.isArray(rawItems) ? rawItems : (rawItems ? [rawItems] : []);
}

app.get('/api/properties', async (req, res) => {
  try {
    const allItems = [];
    for (let page = 1; page <= 10; page++) {
      const items = await fetchRssPage(page);
      allItems.push(...items);
      console.log(`  Page ${page}: ${items.length} items (total: ${allItems.length})`);
      if (items.length < 30) break;
    }
    const seen = new Set();
    const properties = allItems
      .map((item, idx) => {
        const title      = item.title?.__cdata   || item.title   || '';
        const link       = item.link?.__cdata    || item.link    || '';
        const pubDateRaw = item.pubDate          || '';
        const descRaw    = item.description?.__cdata || item.description || '';
        return {
          id: link || `item-${idx}`,
          title: title.trim(), link: link.trim(),
          pubDate: pubDateRaw.trim(),
          pubDateMs: pubDateRaw ? new Date(pubDateRaw).getTime() : 0,
          ...parseDescription(descRaw),
        };
      })
      .filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; });
    properties.sort((a, b) => b.pubDateMs - a.pubDateMs);
    console.log(`✅ Total unique properties: ${properties.length}`);
    res.json({ properties, fetchedAt: new Date().toISOString() });
  } catch (err) {
    console.error('RSS fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🏠 SUUMO Tracker → http://localhost:${PORT}\n`);
});
