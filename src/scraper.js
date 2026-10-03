import { logError, logSuccess } from './utils.js';

const API_URL = 'https://api.divar.ir/v8/postlist/w/search';
const API_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  Referer: 'https://divar.ir/',
  Origin: 'https://divar.ir'
};

function textValue(value) {
  return typeof value === 'string' ? value : value?.text || value?.value || '';
}

function imageValue(data) {
  const image = data.image_url ?? data.image?.url ?? data.image?.[0]?.url ?? data.images?.[0]?.url ?? '';
  return typeof image === 'string' ? image : image?.url || '';
}

export function extractTokensFromApiResponse(response) {
  const widgets = response?.list_widgets || response?.data?.list_widgets || [];
  const listings = new Map();
  for (const widget of widgets) {
    if (!['POST', 'POST_ROW'].includes(widget?.widget_type) || !widget.data) continue;
    const data = widget.data;
    const token = data.token || data.action?.payload?.token;
    if (!token || listings.has(token)) continue;
    const neighborhood = textValue(data.action?.payload?.web_info?.district_persian) || textValue(data.middle_description_text);
    const description = [data.description, data.top_description_text, data.middle_description_text, data.bottom_description_text]
      .map(textValue)
      .filter(Boolean)
      .join(' | ');
    listings.set(token, {
      token,
      title: textValue(data.title),
      description: description || neighborhood,
      neighborhood,
      image_url: imageValue(data)
    });
  }
  return [...listings.values()];
}

export async function fetchListingsPage(env, cityId, category, page, districtIds, responseMetadata = {}) {
  const payload = {
    city_ids: [String(cityId)],
    search_data: {
      form_data: {
        data: {
          category: { str: { value: category } },
          districts: { str: { value: districtIds.map(String).join(',') } }
        }
      }
    },
    pagination_data: {
      '@type': 'type.googleapis.com/post_list.PaginationData',
      page,
      limit: 30
    }
  };

  try {
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

    const count = extractTokensFromApiResponse(data).length;
    await logSuccess(env, 'scraper', API_URL, `Got ${count} listings from district ${districtIds.join(',')}`, response.status);
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