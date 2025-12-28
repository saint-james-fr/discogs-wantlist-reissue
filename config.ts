import { join } from "node:path";

/**
 * Configuration constants for the Discogs Wantlist Checker
 * 
 * Modify these values to customize the behavior of the script.
 */

// File paths
export const WANTLIST_CSV_PATH = join(process.cwd(), "wantlist.csv");

// Year threshold for filtering releases
// Only releases from this year onwards will be included in results
export const MIN_YEAR = 2015;

// Rate limiting configuration
export const RATE_LIMIT = {
  // Authenticated requests per minute (with user token)
  AUTHENTICATED_REQUESTS_PER_MINUTE: 60,
  // Unauthenticated requests per minute (without user token)
  UNAUTHENTICATED_REQUESTS_PER_MINUTE: 25,
  // Rate limit window in milliseconds (sliding window)
  WINDOW_MS: 60000, // 60 seconds
  // Buffer time in milliseconds added to wait calculations
  BUFFER_MS: 100,
  // Conservative delay in milliseconds when timing info is unavailable
  CONSERVATIVE_DELAY_MS: 1000,
  // Threshold: wait if remaining requests are at or below this value
  WAIT_THRESHOLD: 2,
} as const;

// Retry configuration
export const RETRY = {
  // Maximum number of retries for rate limit errors
  MAX_RETRIES: 5,
  // Base delay in milliseconds for exponential backoff (1 minute)
  BASE_DELAY_MS: 60000,
} as const;

// Progress reporting
export const PROGRESS = {
  // Report progress every N releases
  REPORT_INTERVAL: 10,
} as const;

// Default values
export const DEFAULTS = {
  ARTIST: "Unknown",
  TITLE: "Unknown",
} as const;

// API configuration
export const API = {
  USER_AGENT: "wantlist-checker/1.0",
} as const;

// CSV output configuration
export const CSV_OUTPUT = {
  // Prefix for generated result files
  FILENAME_PREFIX: "wantlist-results-",
  // Column headers (MIN_YEAR will be interpolated)
  getHeaders: () => [
    "Original Artist",
    "Original Title",
    "Original Release ID",
    `${MIN_YEAR}+ Release Year`,
    `${MIN_YEAR}+ Release Title`,
    `${MIN_YEAR}+ Release ID`,
    `${MIN_YEAR}+ Release URL`,
  ],
} as const;

