import { logError, logSuccess } from './utils.js';

const API_URL = 'https://api.divar.ir/v8/postlist/w/search';
const PLACES_URL = 'https://map.divarcdn.com/places-web.json';
const API_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  Referer: 'https://divar.ir/',
  Origin: 'https://divar.ir'
};
let tehranPlacesPromise;

async function getTehranNeighborhoodIds() {
  if (!tehranPlacesPromise) {
    tehranPlacesPromise = (async () => {
      const response = await fetch(PLACES_URL);
      if (!response.ok) throw new Error(`Divar places returned HTTP ${response.status}`);
      const places = await response.json();
      if (!Array.isArray(places)) throw new Error('Divar places response is not an array');
      const neighborhoods = new Map();
      for (const place of places) {
        if (String(place.parent) !== '1' || String(place.type) !== '4' || !place.id) continue;
        for (const slug of [place.slug, place.second_slug]) {
          if (slug) neighborhoods.set(String(slug).toLowerCase(), String(place.id));
        }
      }
      return neighborhoods;
    })();
  }

  try {
    return await tehranPlacesPromise;
  } catch (error) {
    tehranPlacesPromise = null;
    throw error;
  }
}

async function resolveNeighborhoodIds(neighborhoodSlugs) {
  const places = neighborhoodSlugs.some((value) => !/^\d+$/.test(String(value)))
    ? await getTehranNeighborhoodIds()
    : new Map();
  return neighborhoodSlugs.map((value) => {
    const neighborhood = String(value).trim();
    if (/^\d+$/.test(neighborhood)) return neighborhood;
    const id = places.get(neighborhood.toLowerCase());
    if (!id) throw new Error(`Could not resolve Tehran neighborhood slug: ${neighborhood}`);
    return id;
  });
}

function textValue(value) {
  return typeof value === 'string' ? value : value?.text || value?.value || '';
}

function imageValue(data) {
  const image = data.image_url ?? data.image?.url ?? data.image?.[0]?.url ?? data.images?.[0]?.url ?? '';
  return typeof image === 'string' ? image : image?.url || '';
}

function normalizeDigits(value) {
  return String(value ?? '').replace(/[۰-۹]/g, (digit) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(digit).toString())
    .replace(/[٬٫،]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseMoneyAmount(rawValue) {
  const text = normalizeDigits(rawValue || '');
  if (!text) return null;
  const numeric = text.match(/\d+(?:[.,]\d+)+(?:\s*\d+)?|\d+/g);
  if (!numeric) return null;
  const parts = numeric.join('').replace(/,/g, '').replace(/\./g, '');
  if (!parts) return null;
  const scale = /میلیارد|بیلیون|billion/i.test(text) ? 1_000_000_000
    : /میلیون|million/i.test(text) ? 1_000_000
    : /هزار|thousand/i.test(text) ? 1_000
    : 1;
  const number = Number.parseInt(parts, 10);
  if (!Number.isFinite(number)) return null;
  return number * scale;
}

function extractMoneyByLabels(text, labels) {
  if (!text) return null;
  const normalized = String(text).replace(/\s+/g, ' ');
  for (const label of labels) {
    const pattern = new RegExp(`(?:${label})\\s*[:：]?\\s*([۰-۹0-9][۰-۹0-9,\s.]*?(?:\\s*(?:میلیون|هزار|میلیارد))?\\s*(?:تومان|ریال))`, 'iu');
    const match = pattern.exec(normalized);
    if (match) {
      const parsed = parseMoneyAmount(match[1]);
      if (parsed !== null) return parsed;
    }
  }
  return null;
}

function extractListingPriceSignals(data, payload = {}) {
  const fields = [
    data.title,
    data.description,
    data.top_description_text,
    data.middle_description_text,
    data.bottom_description_text,
    payload.web_info?.title,
    payload.web_info?.description,
    payload.title,
    payload.description
  ].filter(Boolean);

  const deposit = fields
    .map((field) => extractMoneyByLabels(field, ['ودیعه', 'پیش\s*پرداخت', 'رهن', 'قیمت\s*رهن', 'deposit']))
    .find((value) => value !== null);
  const rent = fields
    .map((field) => extractMoneyByLabels(field, ['اجاره', 'کرایه', 'rent', 'monthly']))
    .find((value) => value !== null);
  const price = fields
    .map((field) => extractMoneyByLabels(field, ['قیمت', 'قیمت\s*کل', 'total', 'price']))
    .find((value) => value !== null);

  return {
    deposit_toman: deposit ?? null,
    rent_toman: rent ?? null,
    price_toman: price ?? deposit ?? rent ?? null
  };
}

export function extractListingsFromApiResponse(response) {
  const widgets = response?.list_widgets || response?.data?.list_widgets || [];
  const listings = new Map();
  for (const widget of widgets) {
    if (!['POST', 'POST_ROW'].includes(widget?.widget_type) || !widget.data) continue;
    const data = widget.data;
    const payload = data.action?.payload || {};
    const webInfo = payload.web_info || {};
    const token = data.token || payload.token;
    if (!token || listings.has(token)) continue;
    const neighborhood = textValue(webInfo.district_persian) || textValue(data.middle_description_text);
    const description = [data.description, data.top_description_text, data.middle_description_text, data.bottom_description_text]
      .map(textValue)
      .filter(Boolean)
      .join(' | ');
    const priceSignals = extractListingPriceSignals(data, payload);
    listings.set(token, {
      token,
      title: textValue(data.title),
      description: description || neighborhood,
      neighborhood,
      image_url: imageValue(data),
      ...priceSignals
    });
  }
  return [...listings.values()];
}

export async function fetchListingsPage(env, cityId, category, page, neighborhoodSlugs, responseMetadata = {}) {
  try {
    const neighborhoodIds = neighborhoodSlugs.length > 0 ? await resolveNeighborhoodIds(neighborhoodSlugs) : [];
    const formData = { category: { str: { value: category } } };
    if (neighborhoodIds.length > 0) formData.districts = { repeated_string: { value: neighborhoodIds } };
    const payload = {
      city_ids: [String(cityId)],
      search_data: { form_data: { data: formData } },
      pagination_data: {
        '@type': 'type.googleapis.com/post_list.PaginationData',
        page,
        limit: 30
      }
    };
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: API_HEADERS,
      body: JSON.stringify(payload)
    });
    const rawResponse = await response.text();
    responseMetadata.httpStatus = response.status;
    responseMetadata.rawResponse = rawResponse;

    if (!response.ok) {
      const message = `HTTP ${response.status} - ${rawResponse.slice(0, 300)}`;
      responseMetadata.error = message;
      await logError(env, 'scraper', API_URL, message, response.status, rawResponse.slice(0, 500));
      return null;
    }

    let data;
    try {
      data = JSON.parse(rawResponse);
    } catch (error) {
      const message = `HTTP ${response.status} - Invalid JSON: ${error.message}`;
      responseMetadata.error = message;
      await logError(env, 'scraper', API_URL, message, response.status, rawResponse.slice(0, 500));
      return null;
    }

    const count = extractListingsFromApiResponse(data).length;
    const neighborhoodLabel = neighborhoodIds.length ? `neighborhood ${neighborhoodIds.join(',')}` : 'Tehran without a neighborhood filter';
    await logSuccess(env, 'scraper', API_URL, `Got ${count} listings from ${neighborhoodLabel}`, response.status);
    return data;
  } catch (error) {
    const message = `HTTP 0 - ${error?.message || error}`;
    responseMetadata.httpStatus = 0;
    responseMetadata.rawResponse = '';
    responseMetadata.error = message;
    await logError(env, 'scraper', API_URL, message, 0);
    return null;
  }
}