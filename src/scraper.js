import { logError, logSuccess, parseLocalizedNumber } from './utils.js';

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'fa-IR,fa;q=0.9,en;q=0.8',
  Accept: 'text/html,application/xhtml+xml',
  Referer: 'https://divar.ir/'
};

export function extractTokensFromListPage(html) {
  const tokens = new Set();
  const pattern = /href\s*=\s*["'](?:https?:\/\/(?:www\.)?divar\.ir)?\/v\/([A-Za-z0-9]+)(?:[/?#][^"']*)?["']/gi;
  for (const match of html.matchAll(pattern)) tokens.add(match[1]);
  return [...tokens];
}

function readMeta(html, key, attribute = 'property') {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<meta\\b(?=[^>]*\\b${attribute}=["']${escaped}["'])[^>]*\\bcontent=["']([^"']*)["'][^>]*>|<meta\\b(?=[^>]*\\bcontent=["']([^"']*)["'])[^>]*\\b${attribute}=["']${escaped}["'][^>]*>`, 'i');
  const match = html.match(pattern);
  return (match?.[1] || match?.[2] || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').trim();
}

function extractNumber(pattern, text) {
  const match = text.match(pattern);
  return match ? parseLocalizedNumber(match[1]) : null;
}

export async function fetchListingDetail(token, env) {
  const url = `https://divar.ir/v/${encodeURIComponent(token)}`;
  try {
    const response = await fetch(url, { headers: BROWSER_HEADERS, redirect: 'follow' });
    const html = await response.text();
    if (!response.ok || html.length < 5000 || /captcha|دسترسی غیرمجاز/i.test(html)) {
      await logError(env, 'scraper', url, 'Listing page blocked, unavailable, or too short', response.status, html.slice(0, 500));
      return null;
    }

    const title = readMeta(html, 'og:title') || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/<[^>]+>/g, '').trim() || '';
    const description = readMeta(html, 'og:description') || readMeta(html, 'description', 'name');
    const imageUrl = readMeta(html, 'og:image');
    const plain = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|&#160;/gi, ' ')
      .replace(/&amp;/gi, '&');
    const number = '[0-9۰-۹٠-٩٬،,]+';
    const price = extractNumber(new RegExp(`قیمت[^\\d۰-۹٠-٩]{0,30}(${number})\\s*(?:تومان|تومن)`, 'i'), plain);
    const size = extractNumber(new RegExp(`(${number})\\s*(?:متر(?:\\s*مربع)?|مترمربع)`, 'i'), plain);
    const rooms = extractNumber(new RegExp(`(${number})\\s*اتاق`, 'i'), plain);
    await logSuccess(env, 'scraper', url, 'Listing page fetched', response.status);
    return { token, url, title, description, image_url: imageUrl, price_toman: price, size_m2: size, rooms, html };
  } catch (error) {
    await logError(env, 'scraper', url, error);
    return null;
  }
}

export async function fetchNeighborhoodPage(slug, baseUrl, env) {
  const url = `${baseUrl.replace(/\/$/, '')}/${encodeURIComponent(slug)}`;
  try {
    const response = await fetch(url, { headers: BROWSER_HEADERS, redirect: 'follow' });
    const html = await response.text();
    if (!response.ok || html.length < 5000 || /captcha|دسترسی غیرمجاز/i.test(html)) {
      await logError(env, 'scraper', url, 'Neighborhood page blocked, unavailable, or too short', response.status, html.slice(0, 500));
      return null;
    }
    return { html, tokens: extractTokensFromListPage(html), url };
  } catch (error) {
    await logError(env, 'scraper', url, error);
    return null;
  }
}