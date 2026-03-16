import express from 'express';
import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { parseDescription } from './lib/rss.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 3001;

const GOOGLE_MAPS_BROWSER_KEY = process.env.GOOGLE_MAPS_KEY_BROWSER || process.env.GOOGLE_MAPS_BROWSER_KEY || '';
const GOOGLE_MAPS_SERVER_KEY  = process.env.GOOGLE_MAPS_KEY_SERVER || process.env.GOOGLE_MAPS_SERVER_KEY || '';
if (!GOOGLE_MAPS_BROWSER_KEY) console.warn('⚠️  GOOGLE_MAPS_KEY_BROWSER not set');
if (!GOOGLE_MAPS_SERVER_KEY)  console.warn('⚠️  GOOGLE_MAPS_KEY_SERVER not set');

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  next();
});

app.use(express.static(__dirname));
app.use(express.static(path.join(__dirname, 'public')));

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
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept':          'application/rss+xml, application/xml, text/xml, */*',
  'Accept-Language': 'ja,en;q=0.9',
  'Referer':         'https://suumo.jp/',
} });

async function googleGeocode(address) {
  if (!GOOGLE_MAPS_SERVER_KEY) return null;
  try {
    const res = await googleClient.get('https://maps.googleapis.com/maps/api/geocode/json', {
      params: { address, key: GOOGLE_MAPS_SERVER_KEY, region: 'jp', language: 'ja' },
    });
    const hit = res.data?.results?.[0];
    if (hit) return {
      lat: hit.geometry.location.lat,
      lng: hit.geometry.location.lng,
      address: hit.formatted_address,
    };
  } catch (err) {
    console.warn('Geocode API error:', err.message);
  }
  return null;
}

async function googlePlacesSearch(query) {
  if (!GOOGLE_MAPS_SERVER_KEY) return null;
  try {
    const res = await googleClient.get('https://maps.googleapis.com/maps/api/place/textsearch/json', {
      params: { query, key: GOOGLE_MAPS_SERVER_KEY, language: 'ja', region: 'jp' },
    });
    const hit = res.data?.results?.[0];
    if (hit) return {
      lat: hit.geometry.location.lat,
      lng: hit.geometry.location.lng,
      address: hit.formatted_address || hit.vicinity || hit.name,
    };
  } catch (err) {
    console.warn('Places API error:', err.message);
  }
  return null;
}

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
  } catch (err) {
    console.warn(`Scrape failed for ${url}: ${err.message}`);
  }
  return null;
}

app.get('/api/config', (req, res) => {
  res.json({
    mapsKey: GOOGLE_MAPS_BROWSER_KEY,
    apiBase: process.env.PUBLIC_API_BASE || '',
  });
});

const geocodeInflight = new Map();

app.get('/api/geocode', async (req, res) => {
  const { link, title, station, line } = req.query;
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

    if (link) {
      const address = await scrapePropertyAddress(link);
      if (address) {
        const geo = await googleGeocode(address);
        if (geo) result = { ...geo, resolvedAddress: address, source: 'address' };
      }
    }

    if (!result && title) {
      const geo = await googlePlacesSearch(title)
        || await googlePlacesSearch(`${title} ${station ? station + '駅' : ''}`.trim());
      if (geo) result = { ...geo, source: 'places' };
    }

    if (!result && station) {
      const geo = await googleGeocode(`${station}駅`)
        || (line ? await googleGeocode(`${line} ${station}駅`) : null);
      if (geo) result = { ...geo, source: 'station' };
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
