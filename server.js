import express from 'express';
import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { parseDescription } from './lib/rss.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

const GOOGLE_MAPS_BROWSER_KEY = process.env.GOOGLE_MAPS_KEY_BROWSER || process.env.GOOGLE_MAPS_BROWSER_KEY || '';
const GOOGLE_MAPS_SERVER_KEY = process.env.GOOGLE_MAPS_KEY_SERVER || process.env.GOOGLE_MAPS_SERVER_KEY || '';
const PUBLIC_API_BASE = process.env.PUBLIC_API_BASE || '';
const ALLOWED_ORIGINS = parseAllowedOrigins(process.env.ALLOWED_ORIGINS);
const GEOCODE_RATE_LIMIT_WINDOW_MS = parsePositiveInt(process.env.GEOCODE_RATE_LIMIT_WINDOW_MS, 60_000);
const GEOCODE_RATE_LIMIT_MAX = parsePositiveInt(process.env.GEOCODE_RATE_LIMIT_MAX, 30);
const SUUMO_ALLOWED_HOSTS = new Set(['suumo.jp', 'www.suumo.jp']);

if (!GOOGLE_MAPS_BROWSER_KEY) console.warn('⚠️  GOOGLE_MAPS_KEY_BROWSER not set');
if (!GOOGLE_MAPS_SERVER_KEY) console.warn('⚠️  GOOGLE_MAPS_KEY_SERVER not set');
if (ALLOWED_ORIGINS.size === 0) console.warn('⚠️  ALLOWED_ORIGINS not set; defaulting to same-origin only for API responses');

const geocodeRateLimit = new Map();

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseAllowedOrigins(raw) {
  return new Set(
    String(raw || '')
      .split(',')
      .map(v => v.trim())
      .filter(Boolean)
  );
}

function getRequestOrigin(req) {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin) return origin;
  return null;
}

function applyApiCors(req, res) {
  const origin = getRequestOrigin(req);
  if (!origin) return;
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
}

function sameOriginApiOnly(req, res, next) {
  applyApiCors(req, res);
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.sendStatus(204);
  }
  next();
}

function normalizeText(value, maxLen = 200) {
  const normalized = String(value || '').trim().replace(/\s+/g, ' ');
  return normalized.slice(0, maxLen);
}

function isAllowedSuumoUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:' && SUUMO_ALLOWED_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

function clientIp(req) {
  return (req.headers['x-forwarded-for']?.toString().split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';
}

function enforceRateLimit(req, res, next) {
  const key = clientIp(req);
  const now = Date.now();
  const entry = geocodeRateLimit.get(key);
  if (!entry || entry.resetAt <= now) {
    geocodeRateLimit.set(key, { count: 1, resetAt: now + GEOCODE_RATE_LIMIT_WINDOW_MS });
    return next();
  }
  if (entry.count >= GEOCODE_RATE_LIMIT_MAX) {
    const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    res.setHeader('Retry-After', retryAfterSec);
    return res.status(429).json({ error: 'Too many geocode requests', retryAfterSec });
  }
  entry.count += 1;
  next();
}

app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', sameOriginApiOnly);

const GEOCACHE_FILE = path.join(__dirname, 'geocache.json');
let geocache = {};
try { geocache = JSON.parse(fs.readFileSync(GEOCACHE_FILE, 'utf8')); } catch {}

function saveGeocache() {
  try { fs.writeFileSync(GEOCACHE_FILE, JSON.stringify(geocache, null, 2)); } catch (e) {
    console.warn('Could not save geocache:', e.message);
  }
}

console.log(`📦 Geocache loaded: ${Object.keys(geocache).length} entries`);

const googleClient = axios.create({ timeout: 6000 });
const rssClient = axios.create({ timeout: 15000, headers: {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept': 'application/rss+xml, application/xml, text/xml, */*',
  'Accept-Language': 'ja,en;q=0.9',
  'Referer': 'https://suumo.jp/',
} });

async function googleGeocode(address) {
  if (!GOOGLE_MAPS_SERVER_KEY) return { ok: false, reason: 'missing-server-key', query: address };
  try {
    const res = await googleClient.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: { address, key: GOOGLE_MAPS_SERVER_KEY, region: 'jp', language: 'ja' },
    });
    const hit = res.data?.results?.[0];
    if (hit) return {
      ok: true,
      lat: hit.geometry.location.lat,
      lng: hit.geometry.location.lng,
      address: hit.formatted_address,
      query: address,
      apiStatus: res.data?.status || 'OK',
    };
    return { ok: false, reason: 'geocode-no-result', query: address, apiStatus: res.data?.status || 'ZERO_RESULTS' };
  } catch (err) {
    console.warn('Geocode API error:', err.message);
    return { ok: false, reason: 'geocode-error', query: address, error: err.message };
  }
}

async function googlePlacesSearch(query) {
  if (!GOOGLE_MAPS_SERVER_KEY) return { ok: false, reason: 'missing-server-key', query };
  try {
    const res = await googleClient.get('https://maps.googleapis.com/maps/api/place/textsearch/json', {
      params: { query, key: GOOGLE_MAPS_SERVER_KEY, language: 'ja', region: 'jp' },
    });
    const hit = res.data?.results?.[0];
    if (hit) return {
      ok: true,
      lat: hit.geometry.location.lat,
      lng: hit.geometry.location.lng,
      address: hit.formatted_address || hit.vicinity || hit.name,
      query,
      apiStatus: res.data?.status || 'OK',
    };
    return { ok: false, reason: 'places-no-result', query, apiStatus: res.data?.status || 'ZERO_RESULTS' };
  } catch (err) {
    console.warn('Places API error:', err.message);
    return { ok: false, reason: 'places-error', query, error: err.message };
  }
}

function decodeBrokenText(value) {
  const input = normalizeText(value, 200);
  if (!input) return '';
  return input.replace(/�/g, '').trim();
}

function buildPlacesQueries({ title, station, line }) {
  const cleanTitle = decodeBrokenText(title);
  const cleanStation = decodeBrokenText(station);
  const cleanLine = decodeBrokenText(line);
  const stationLabel = cleanStation ? `${cleanStation}駅` : '';
  return [
    cleanTitle,
    [cleanTitle, stationLabel].filter(Boolean).join(' '),
    [cleanTitle, stationLabel, '東京都'].filter(Boolean).join(' '),
    [cleanTitle, cleanLine, stationLabel].filter(Boolean).join(' '),
    [cleanTitle, cleanLine, stationLabel, '東京都'].filter(Boolean).join(' '),
    [stationLabel, '東京都'].filter(Boolean).join(' '),
    [cleanLine, stationLabel, '東京都'].filter(Boolean).join(' '),
  ].filter(Boolean).filter((value, index, arr) => arr.indexOf(value) === index);
}

async function scrapePropertyAddress(url) {
  if (!isAllowedSuumoUrl(url)) return null;
  try {
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept-Language': 'ja,en;q=0.9',
        'Referer': 'https://suumo.jp/',
      },
      timeout: 10000,
      responseType: 'text',
      maxRedirects: 3,
      validateStatus: status => status >= 200 && status < 400,
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
  } catch (err) {
    console.warn(`Scrape failed for ${url}: ${err.message}`);
  }
  return null;
}

app.get('/api/config', (req, res) => {
  res.json({
    mapsKey: GOOGLE_MAPS_BROWSER_KEY,
    apiBase: PUBLIC_API_BASE,
  });
});

const geocodeInflight = new Map();

app.get('/api/geocode', enforceRateLimit, async (req, res) => {
  const link = normalizeText(req.query.link, 500);
  const title = normalizeText(req.query.title, 160);
  const station = normalizeText(req.query.station, 80);
  const line = normalizeText(req.query.line, 120);

  if (link && !isAllowedSuumoUrl(link)) {
    return res.status(400).json({ error: 'Only HTTPS suumo.jp listing URLs are allowed' });
  }

  const cacheKey = link || title;
  if (!cacheKey) return res.json(null);

  if (geocache[cacheKey] !== undefined) {
    return res.json(geocache[cacheKey]);
  }

  if (geocodeInflight.has(cacheKey)) {
    return res.json(await geocodeInflight.get(cacheKey));
  }

  const job = (async () => {
    let result = null;
    const debug = { attempts: [] };

    if (link) {
      const address = await scrapePropertyAddress(link);
      if (address) {
        const geo = await googleGeocode(address);
        debug.attempts.push({ step: 'address', ...geo, resolvedAddress: address });
        if (geo.ok) result = { ...geo, resolvedAddress: address, source: 'address', debug };
      } else {
        debug.attempts.push({ step: 'address', ok: false, reason: 'address-scrape-failed', query: link });
      }
    }

    if (!result && title) {
      for (const query of buildPlacesQueries({ title, station, line })) {
        const geo = await googlePlacesSearch(query);
        debug.attempts.push({ step: 'places', ...geo });
        if (geo.ok) {
          result = { ...geo, source: 'places', query, debug };
          break;
        }
      }
    }

    if (!result && station) {
      const stationLabel = `${decodeBrokenText(station)}駅`;
      const lineLabel = decodeBrokenText(line);
      const stationQueries = [
        `${stationLabel} 東京都`,
        lineLabel ? `${lineLabel} ${stationLabel} 東京都` : '',
        stationLabel,
        lineLabel ? `${lineLabel} ${stationLabel}` : '',
      ].filter(Boolean);
      for (const query of stationQueries) {
        const geo = await googleGeocode(query);
        debug.attempts.push({ step: 'station', ...geo });
        if (geo.ok) {
          result = { ...geo, source: 'station', debug };
          break;
        }
      }
    }

    if (!result) {
      result = { ok: false, source: 'failed', debug, reason: debug.attempts.at(-1)?.reason || 'no-match' };
    }

    geocache[cacheKey] = result;
    saveGeocache();
    return result;
  })();

  geocodeInflight.set(cacheKey, job);
  try {
    res.json(await job);
  } finally {
    geocodeInflight.delete(cacheKey);
  }
});

const RSS_BASE = 'https://suumo.jp/jj/bukken/ichiran/JJ011FC001/?ar=030&bs=010&nf=010001&rssFlg=1';
const rssParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: true,
  trimValues: true,
  cdataPropName: '__cdata',
});

async function fetchRssPage(page) {
  const url = page === 1 ? RSS_BASE : `${RSS_BASE}&pn=${page}`;
  const res = await rssClient.get(url, { responseType: 'text' });
  const parsed = rssParser.parse(res.data);
  const rawItems = parsed?.rss?.channel?.item || [];
  return Array.isArray(rawItems) ? rawItems : (rawItems ? [rawItems] : []);
}

let rssCache = { expiresAt: 0, payload: null };

app.get('/api/properties', async (req, res) => {
  try {
    const now = Date.now();
    if (rssCache.payload && rssCache.expiresAt > now) {
      return res.json({ ...rssCache.payload, cache: 'hit' });
    }

    const allItems = [];
    for (let page = 1; page <= 10; page++) {
      const items = await fetchRssPage(page);
      allItems.push(...items);
      if (items.length < 30) break;
    }

    const seen = new Set();
    const properties = allItems
      .map((item, idx) => {
        const title = item.title?.__cdata || item.title || '';
        const link = item.link?.__cdata || item.link || '';
        const pubDateRaw = item.pubDate || '';
        const descRaw = item.description?.__cdata || item.description || '';
        return {
          id: link || `item-${idx}`,
          title: title.trim(),
          link: link.trim(),
          pubDate: pubDateRaw.trim(),
          pubDateMs: pubDateRaw ? new Date(pubDateRaw).getTime() : 0,
          ...parseDescription(descRaw),
        };
      })
      .filter(p => {
        if (seen.has(p.id)) return false;
        seen.add(p.id);
        return true;
      })
      .sort((a, b) => b.pubDateMs - a.pubDateMs);

    const payload = { properties, fetchedAt: new Date().toISOString(), cache: 'miss' };
    rssCache = { payload, expiresAt: now + 5 * 60 * 1000 };
    res.json(payload);
  } catch (err) {
    console.error('RSS fetch error:', err.message);
    const status = /429/.test(err.message) ? 429 : 502;
    res.status(status).json({ error: 'Failed to fetch property feed', detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n🏠 SUUMO Tracker → http://localhost:${PORT}\n`);
});
