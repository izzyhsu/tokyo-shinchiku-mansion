import express from 'express';
import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 3001;

// Read API key from environment (set via .env file or shell export)
const GOOGLE_MAPS_KEY = process.env.GOOGLE_MAPS_KEY || '';
if (!GOOGLE_MAPS_KEY) console.warn('⚠️  GOOGLE_MAPS_KEY not set — map will not load on the frontend');
// Allow requests from GitHub Pages and localhost
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Text helpers ──────────────────────────────────────────────────────────────
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

// ── Routes ─────────────────────────────────────────────────────────────────────

// Frontend fetches this to get the Maps key at runtime (key never in public HTML)
app.get('/api/config', (req, res) => {
  res.json({ mapsKey: GOOGLE_MAPS_KEY });
});

const RSS_BASE    = 'https://suumo.jp/jj/bukken/ichiran/JJ011FC001/?ar=030&bs=010&nf=010001&rssFlg=1';
const RSS_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  'Accept':          'application/rss+xml, application/xml, text/xml, */*',
  'Accept-Language': 'ja,en;q=0.9',
  'Referer':         'https://suumo.jp/',
};

const rssParser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: true,
  trimValues: true,
  cdataPropName: '__cdata',
});

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
    const MAX_PAGES = 10;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const items = await fetchRssPage(page);
      allItems.push(...items);
      console.log(`  Page ${page}: ${items.length} items (total so far: ${allItems.length})`);
      // SUUMO returns fewer than 30 on the last page
      if (items.length < 30) break;
    }

    const seen       = new Set();
    const properties = allItems
      .map((item, idx) => {
        const title      = item.title?.__cdata   || item.title   || '';
        const link       = item.link?.__cdata    || item.link    || '';
        const pubDateRaw = item.pubDate          || '';
        const descRaw    = item.description?.__cdata || item.description || '';
        const parsed     = parseDescription(descRaw);
        return {
          id: link || `item-${idx}`,
          title: title.trim(),
          link:  link.trim(),
          pubDate:   pubDateRaw.trim(),
          pubDateMs: pubDateRaw ? new Date(pubDateRaw).getTime() : 0,
          ...parsed,
        };
      })
      .filter(p => {
        if (seen.has(p.id)) return false;
        seen.add(p.id);
        return true;
      });

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
