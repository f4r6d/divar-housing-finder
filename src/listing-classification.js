function normalizeListingText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u200c\u200d\s]+/g, '')
    .toLowerCase();
}

export function isSharedHousingListing(title, description, propertyType = '') {
  if (String(propertyType).toLowerCase() === 'room') return true;
  const text = normalizeListingText(`${title || ''} ${description || ''}`);
  return /همخانه|هماتاقی|اتاقمشترک|خانهمشترک|واحدمشترک/.test(text);
}
