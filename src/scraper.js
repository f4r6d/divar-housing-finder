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

async function getTehranDistrictIds() {
  if (!tehranPlacesPromise) {
    tehranPlacesPromise = (async () => {
      const response = await fetch(PLACES_URL);
      if (!response.ok) throw new Error(`Divar places returned HTTP ${response.status}`);
      const places = await response.json();
      if (!Array.isArray(places)) throw new Error('Divar places response is not an array');
      const districts = new Map();
      for (const place of places) {
        if (String(place.parent) !== '1' || String(place.type) !== '4' || !place.id) continue;
        for (const slug of [place.slug, place.second_slug]) {
          if (slug) districts.set(String(slug).toLowerCase(), String(place.id));
        }
      }
      return districts;
    })();
  }

  try {
    return await tehranPlacesPromise;
  } catch (error) {
    tehranPlacesPromise = null;
    throw error;
  }
}

async function resolveDistrictIds(districtSlugs) {
  const places = districtSlugs.some((value) => !/^\d+$/.test(String(value)))
    ? await getTehranDistrictIds()
    : new Map();
  return districtSlugs.map((value) => {
    const district = String(value).trim();
    if (/^\d+$/.test(district)) return district;
    const id = places.get(district.toLowerCase());
    if (!id) throw new Error(`Could not resolve Tehran district slug: ${district}`);
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

const PERSIAN_LATIN = {
  'ا': 'a', 'آ': 'a', 'أ': 'a', 'إ': 'e', 'ب': 'b', 'پ': 'p', 'ت': 't', 'ث': 's',
  'ج': 'j', 'چ': 'ch', 'ح': 'h', 'خ': 'kh', 'د': 'd', 'ذ': 'z', 'ر': 'r', 'ز': 'z',
  'ژ': 'zh', 'س': 's', 'ش': 'sh', 'ص': 's', 'ض': 'z', 'ط': 't', 'ظ': 'z', 'ع': 'a',
  'غ': 'gh', 'ف': 'f', 'ق': 'gh', 'ک': 'k', 'ك': 'k', 'گ': 'g', 'ل': 'l', 'م': 'm',
  'ن': 'n', 'و': 'v', 'ه': 'h', 'ة': 'h', 'ی': 'i', 'ي': 'i', 'ئ': 'i', 'ؤ': 'v', 'ء': ''
};

export function slugifyDistrict(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[آ-یكءأإةؤئ]/g, (character) => PERSIAN_LATIN[character] || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
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
    const districtData = data.district || payload.district || {};
    const districtNameFa = textValue(districtData.name_fa) || textValue(districtData.name) ||
      textValue(data.district_name_fa) || textValue(webInfo.district_persian) ||
      (typeof districtData === 'string' && /[\u0600-\u06ff]/.test(districtData) ? districtData : '');
    const explicitDistrictSlug = textValue(districtData.slug) || textValue(data.district_slug) ||
      textValue(payload.district_slug) || textValue(webInfo.district_slug) ||
      (typeof districtData === 'string' && !/[\u0600-\u06ff]/.test(districtData) ? districtData : '');
    const districtSlug = explicitDistrictSlug || slugifyDistrict(districtNameFa);
    const neighborhood = textValue(webInfo.district_persian) || textValue(data.middle_description_text);
    const description = [data.description, data.top_description_text, data.middle_description_text, data.bottom_description_text]
      .map(textValue)
      .filter(Boolean)
      .join(' | ');
    listings.set(token, {
      token,
      title: textValue(data.title),
      description: description || neighborhood,
      neighborhood,
      district_slug: districtSlug,
      district_name_fa: districtNameFa || districtSlug,
      image_url: imageValue(data)
    });
  }
  return [...listings.values()];
}

export async function fetchListingsPage(env, cityId, category, page, districtSlugs, responseMetadata = {}) {
  try {
    const districtIds = districtSlugs.length > 0 ? await resolveDistrictIds(districtSlugs) : [];
    const formData = { category: { str: { value: category } } };
    if (districtIds.length > 0) formData.districts = { repeated_string: { value: districtIds } };
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
    const districtLabel = districtIds.length ? `district ${districtIds.join(',')}` : 'Tehran without a district filter';
    await logSuccess(env, 'scraper', API_URL, `Got ${count} listings from ${districtLabel}`, response.status);
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