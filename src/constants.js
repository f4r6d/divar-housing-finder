export const DAILY_LISTING_LIMIT_MAX = 500;
export const DAILY_LISTING_LIMIT_DEFAULT = 500;
export const DAILY_LISTING_LIMIT_MIN = 3;
export const LISTINGS_PER_PAGE = 30;
export const MAX_PAGES_PER_NEIGHBORHOOD = 20;

// Free-plan Workflows budgets are cumulative per Workflow *instance* (50 external subrequests,
// 1,000 internal). Each phase therefore processes a bounded slice and chains a successor instance.
export const SCRAPE_HOODS_PER_INSTANCE = 8;
export const SCRAPE_PAGES_PER_INSTANCE = 32;   // hard cap on external search fetches per instance
export const EXTRACT_SLICE = 40;
export const EXTRACT_CHUNK = 5;
export const JEV_SLICE = 40;
export const EXCLUDE_IDS_MAX = 90;             // leave room under D1's 100 bound-parameter limit
export const LEASE_STALE_MS = 30 * 60 * 1000;  // chain lease considered stale after 30 minutes
