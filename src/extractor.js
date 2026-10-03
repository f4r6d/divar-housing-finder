import { isAiQuotaExhausted, logError, logSuccess, markAiQuotaExhausted } from './utils.js';

const MODEL = '@cf/qwen/qwen2.5-7b-instruct';

function parseModelResponse(result) {
  const output = typeof result === 'string' ? result : (result?.response ?? result?.output_text ?? result);
  if (typeof output === 'object' && output !== null) return output;
  const text = String(output || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(text);
}

export async function extractListingData(env, listing) {
  if (await isAiQuotaExhausted(env)) return null;
  if (!env.AI) {
    await logError(env, 'workers-ai', listing.url, 'Workers AI binding is unavailable');
    return null;
  }

  try {
    const text = [listing.description, listing.neighborhood].filter(Boolean).join('\n').slice(0, 4000);
    if (!listing.title && !text) {
      await logError(env, 'workers-ai', listing.url, 'Listing summary has no text to extract');
      return null;
    }

    const result = await env.AI.run(MODEL, {
      messages: [
        { role: 'system', content: 'Extract housing rental listing facts. Return only valid JSON. Preserve numeric amounts in toman. Handle Persian and Arabic numerals.' },
        { role: 'user', content: `آگهی زیر را تحلیل کن و فقط یک JSON با کلیدهای مشخص‌شده برگردان. مقدار نامشخص را null قرار بده. description حداکثر ۳۰۰ نویسه باشد.\n{ "price_toman": number|null, "rent_toman": number|null, "deposit_toman": number|null, "size_m2": number|null, "rooms": number|null, "property_type": "apartment"|"house"|"room"|"other", "description": string, "has_bait_signals": boolean, "suspicious_phrases": string[] }\n\nعنوان: ${listing.title || ''}\nمتن: ${text}` }
      ],
      response_format: { type: 'json_object' }
    });
    const data = parseModelResponse(result);
    await logSuccess(env, 'workers-ai', listing.url, `Extracted listing ${listing.id}`);
    return data;
  } catch (error) {
    const message = String(error?.message || error);
    await logError(env, 'workers-ai', listing.url, error);
    if (/4006|daily free allocation/i.test(message)) await markAiQuotaExhausted(env);
    return null;
  }
}