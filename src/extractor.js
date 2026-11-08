export const MODEL = '@cf/qwen/qwen3-30b-a3b-fp8';

const SYSTEM_PROMPT = 'Extract housing rental listing facts. Return only valid JSON. Preserve numeric amounts in toman. Handle Persian and Arabic numerals. For explicitly negotiable or convertible deposit/rent terms, report the option with the highest deposit; use 100/3 toman of deposit for each 1 toman of monthly rent (100,000,000 toman deposit for 3,000,000 toman monthly rent) when calculating a full conversion. Never invent negotiability when the listing does not state it.';

function listingText(listing) {
  return [listing.description, listing.neighborhood].filter(Boolean).join('\n').slice(0, 4000);
}

export function hasExtractableText(listing) {
  return Boolean(listing.title || listingText(listing));
}

function userPrompt(listing) {
  return `آگهی زیر را تحلیل کن و فقط یک JSON با کلیدهای مشخص‌شده برگردان. مقدار نامشخص را null قرار بده. در صورت امکان تبدیل ودیعه و اجاره، deposit_toman و rent_toman را برای گزینه‌ای ثبت کن که بیشترین ودیعه را دارد و rent_deposit_flexible را true بگذار؛ در غیر این صورت مبالغ آگهی را همان‌طور که درج شده ثبت کن و این پرچم false باشد. description حداکثر ۳۰۰ نویسه باشد.\n{ "price_toman": number|null, "rent_toman": number|null, "deposit_toman": number|null, "rent_deposit_flexible": boolean, "size_m2": number|null, "rooms": number|null, "property_type": "apartment"|"house"|"room"|"other", "description": string, "has_bait_signals": boolean, "suspicious_phrases": string[] }\n\nعنوان: ${listing.title || ''}\nمتن: ${listingText(listing)}`;
}

// Dispatches exactly one Workers AI request and returns the raw model result. It never touches the
// database and never catches its own errors, so a durable Workflow step can cache the result and a
// transport/limit failure can be classified by the caller. Any successful request — even one whose
// body turns out to be invalid JSON — has already consumed a call by the time this returns.
export async function callExtractionModel(env, listing) {
  if (!env.AI) throw new Error('Workers AI binding is unavailable');
  return env.AI.run(MODEL, {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt(listing) }
    ],
    response_format: { type: 'json_object' }
  });
}

// Best-effort parse of a raw model result. Returns null on malformed JSON instead of throwing so the
// caller can treat it as a failed extraction without re-invoking the (already consumed) AI call.
export function parseExtractionResult(result) {
  try {
    const output = typeof result === 'string' ? result : (result?.response ?? result?.output_text ?? result);
    if (typeof output === 'object' && output !== null) return output;
    const text = String(output || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function classifyExtractionError(error) {
  const message = String(error?.message || error);
  if (/4006|daily free allocation/i.test(message)) return 'quota_exhausted';
  if (/subrequest|too many subrequests/i.test(message)) return 'subrequest_limit';
  return 'extraction_failed';
}
