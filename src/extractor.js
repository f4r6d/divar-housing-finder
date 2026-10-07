import { isAiQuotaExhausted, logError, logSuccess, markAiQuotaExhausted } from './utils.js';

const MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';

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
        { role: 'system', content: 'Extract housing rental listing facts. Return only valid JSON. Preserve numeric amounts in toman. Handle Persian and Arabic numerals. For explicitly negotiable or convertible deposit/rent terms, report the option with the highest deposit; use 100/3 toman of deposit for each 1 toman of monthly rent (100,000,000 toman deposit for 3,000,000 toman monthly rent) when calculating a full conversion. Never invent negotiability when the listing does not state it.' },
        { role: 'user', content: `آگهی زیر را تحلیل کن و فقط یک JSON با کلیدهای مشخص‌شده برگردان. مقدار نامشخص را null قرار بده. در صورت امکان تبدیل ودیعه و اجاره، deposit_toman و rent_toman را برای گزینه‌ای ثبت کن که بیشترین ودیعه را دارد و rent_deposit_flexible را true بگذار؛ در غیر این صورت مبالغ آگهی را همان‌طور که درج شده ثبت کن و این پرچم false باشد. description حداکثر ۳۰۰ نویسه باشد.\n{ "price_toman": number|null, "rent_toman": number|null, "deposit_toman": number|null, "rent_deposit_flexible": boolean, "size_m2": number|null, "rooms": number|null, "property_type": "apartment"|"house"|"room"|"other", "description": string, "has_bait_signals": boolean, "suspicious_phrases": string[] }\n\nعنوان: ${listing.title || ''}\nمتن: ${text}` }
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