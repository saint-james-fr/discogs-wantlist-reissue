import { DiscogsClient } from "@lionralfs/discogs-client";
import { parse } from "csv-parse/sync";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  WANTLIST_CSV_PATH,
  MIN_YEAR,
  RATE_LIMIT,
  RETRY,
  PROGRESS,
  DEFAULTS,
  API,
  CSV_OUTPUT,
} from "./config.js";

type ReleaseInfo = {
  releaseId: number;
  artist?: string;
  title?: string;
  hasPostMinYearRelease: boolean;
  postMinYearReleases: Array<{
    id: number;
    title: string;
    year: number;
    url: string;
  }>;
};

type CsvRow = {
  "Catalog#": string;
  Artist: string;
  Title: string;
  Label: string;
  Format: string;
  Rating: string;
  Released: string;
  release_id: string;
  Notes: string;
};

// Rate limiter that tracks requests in a sliding window
class RateLimiter {
  private requestTimestamps: number[] = [];
  private maxRequests: number;
  private windowMs = RATE_LIMIT.WINDOW_MS;

  constructor(maxRequests: number) {
    this.maxRequests = maxRequests;
  }

  // Clean up old requests outside the window
  private cleanup(): void {
    const now = Date.now();
    this.requestTimestamps = this.requestTimestamps.filter(
      (timestamp) => now - timestamp < this.windowMs
    );
  }

  // Get number of requests in the current window
  getRequestsInWindow(): number {
    this.cleanup();
    return this.requestTimestamps.length;
  }

  // Get remaining requests available
  getRemaining(): number {
    return Math.max(0, this.maxRequests - this.getRequestsInWindow());
  }

  // Record a request
  recordRequest(): void {
    this.cleanup();
    this.requestTimestamps.push(Date.now());
  }

  // Wait if necessary to respect rate limits
  async waitIfNeeded(remainingFromHeader?: number): Promise<void> {
    this.cleanup();
    const requestsInWindow = this.requestTimestamps.length;
    const remaining = remainingFromHeader !== undefined ? remainingFromHeader : this.getRemaining();

    // If we're close to the limit, wait
    if (remaining <= RATE_LIMIT.WAIT_THRESHOLD) {
      // Calculate how long to wait until the oldest request falls out of the window
      if (this.requestTimestamps.length > 0) {
        const oldestRequest = this.requestTimestamps[0];
        const waitTime = this.windowMs - (Date.now() - oldestRequest) + RATE_LIMIT.BUFFER_MS;
        if (waitTime > 0) {
          console.log(`⏳ Rate limit: ${requestsInWindow}/${this.maxRequests} used. Waiting ${Math.ceil(waitTime / 1000)}s...`);
          await sleep(waitTime);
          this.cleanup();
        }
      } else {
        // Conservative delay if we don't have timing info
        await sleep(RATE_LIMIT.CONSERVATIVE_DELAY_MS);
      }
    }
  }
}

let isAuthenticated = false;
let rateLimiter: RateLimiter;

const getClient = (): DiscogsClient => {
  const userToken = process.env.DISCOGS_USER_TOKEN;

  if (userToken) {
    isAuthenticated = true;
    rateLimiter = new RateLimiter(RATE_LIMIT.AUTHENTICATED_REQUESTS_PER_MINUTE);
    return new DiscogsClient({
      userAgent: API.USER_AGENT,
      auth: { userToken },
    });
  }

  // Fallback to unauthenticated client
  isAuthenticated = false;
  rateLimiter = new RateLimiter(RATE_LIMIT.UNAUTHENTICATED_REQUESTS_PER_MINUTE);
  console.warn(
    `⚠️  Warning: No authentication provided. Using unauthenticated mode (${RATE_LIMIT.UNAUTHENTICATED_REQUESTS_PER_MINUTE} req/min limit).\n` +
      `   For better rate limits (${RATE_LIMIT.AUTHENTICATED_REQUESTS_PER_MINUTE} req/min), set DISCOGS_USER_TOKEN environment variable.\n` +
      "   Get your token at: https://www.discogs.com/settings/developers\n"
  );
  return new DiscogsClient({
    userAgent: API.USER_AGENT,
  });
};

const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

const checkReleaseForPostMinYearVersions = async (
  client: DiscogsClient,
  releaseId: number,
  artist?: string,
  title?: string,
  retryCount = 0
): Promise<ReleaseInfo> => {
  const maxRetries = RETRY.MAX_RETRIES;
  const baseDelay = RETRY.BASE_DELAY_MS;

  try {
    // Wait if needed before making request
    await rateLimiter.waitIfNeeded();

    // Get the release to find the master_id
    let releaseResponse;
    try {
      releaseResponse = await client.database().getRelease(releaseId);
      rateLimiter.recordRequest();

      // Check rate limit headers from response
      const rateLimitRemaining = releaseResponse.rateLimit?.remaining;
      if (rateLimitRemaining !== undefined) {
        await rateLimiter.waitIfNeeded(rateLimitRemaining);
      }
    } catch (error: any) {
      if (error.statusCode === 429 && retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount); // Exponential backoff
        console.log(
          `⚠️  Rate limit hit for release ${releaseId}. Waiting ${delay / 1000}s before retry ${retryCount + 1}/${maxRetries}...`
        );
        await sleep(delay);
        return checkReleaseForPostMinYearVersions(client, releaseId, artist, title, retryCount + 1);
      }
      throw error;
    }

    const release = releaseResponse.data;

    if (!release.master_id) {
      return {
        releaseId,
        artist,
        title,
        hasPostMinYearRelease: false,
        postMinYearReleases: [],
      };
    }

    // Wait if needed before making second request
    await rateLimiter.waitIfNeeded();

    // Get all versions of the master release
    let masterVersionsResponse;
    try {
      masterVersionsResponse = await client.database().getMasterVersions(release.master_id);
      rateLimiter.recordRequest();

      // Check rate limit headers from response
      const rateLimitRemaining = masterVersionsResponse.rateLimit?.remaining;
      if (rateLimitRemaining !== undefined) {
        await rateLimiter.waitIfNeeded(rateLimitRemaining);
      }
    } catch (error: any) {
      if (error.statusCode === 429 && retryCount < maxRetries) {
        const delay = baseDelay * Math.pow(2, retryCount); // Exponential backoff
        console.log(
          `⚠️  Rate limit hit for master ${release.master_id}. Waiting ${delay / 1000}s before retry ${retryCount + 1}/${maxRetries}...`
        );
        await sleep(delay);
        return checkReleaseForPostMinYearVersions(client, releaseId, artist, title, retryCount + 1);
      }
      throw error;
    }

    const versions = masterVersionsResponse.data.versions || [];

    // Filter for releases from MIN_YEAR onwards (MIN_YEAR included)
    const postMinYearReleases = versions
      .filter((version) => {
        // Check both year (number) and released (string date) fields
        const year = (version as any).year;
        const released = (version as any).released;

        if (year && typeof year === "number") {
          return year >= MIN_YEAR;
        }

        // If released is a string, try to extract year
        if (released && typeof released === "string") {
          const yearMatch = released.match(/(\d{4})/);
          if (yearMatch) {
            const extractedYear = parseInt(yearMatch[1], 10);
            return extractedYear >= MIN_YEAR;
          }
        }

        return false;
      })
      .map((version) => {
        const year = (version as any).year;
        const released = (version as any).released;
        let releaseYear = 0;

        if (year && typeof year === "number") {
          releaseYear = year;
        } else if (released && typeof released === "string") {
          const yearMatch = released.match(/(\d{4})/);
          if (yearMatch) {
            releaseYear = parseInt(yearMatch[1], 10);
          }
        }

        return {
          id: version.id,
          title: (version as any).title || DEFAULTS.TITLE,
          year: releaseYear,
          url: `https://www.discogs.com/release/${version.id}`,
        };
      });

    return {
      releaseId,
      artist,
      title,
      hasPostMinYearRelease: postMinYearReleases.length > 0,
      postMinYearReleases,
    };
  } catch (error: any) {
    if (error.statusCode === 429 && retryCount < maxRetries) {
      const delay = baseDelay * Math.pow(2, retryCount); // Exponential backoff
      console.log(
        `⚠️  Rate limit hit for release ${releaseId}. Waiting ${delay / 1000}s before retry ${retryCount + 1}/${maxRetries}...`
      );
      await sleep(delay);
      return checkReleaseForPostMinYearVersions(client, releaseId, artist, title, retryCount + 1);
    }

    console.error(`Error checking release ${releaseId}:`, error.message || error);
    // Return a result indicating error but don't throw
    return {
      releaseId,
      artist,
      title,
      hasPostMinYearRelease: false,
      postMinYearReleases: [],
    };
  }
};

const parseCsvFile = (filePath: string): CsvRow[] => {
  const fileContent = readFileSync(filePath, "utf-8");
  const records = parse(fileContent, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  }) as CsvRow[];
  return records;
};

const extractReleaseIds = (rows: CsvRow[]): Array<{ id: number; artist: string; title: string }> => {
  const releaseIds: Array<{ id: number; artist: string; title: string }> = [];

  for (const row of rows) {
    const releaseId = parseInt(row.release_id, 10);
    if (!isNaN(releaseId) && releaseId > 0) {
      releaseIds.push({
        id: releaseId,
        artist: row.Artist || DEFAULTS.ARTIST,
        title: row.Title || DEFAULTS.TITLE,
      });
    }
  }

  return releaseIds;
};

const escapeCsvField = (field: string | number): string => {
  const str = String(field);
  // If field contains comma, quote, or newline, wrap in quotes and escape quotes
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

const writeResultsToCsv = (results: ReleaseInfo[], outputPath: string): void => {
  const headers = CSV_OUTPUT.getHeaders();

  const csvRows: string[] = [headers.map(escapeCsvField).join(",")];

  for (const result of results) {
    if (result.postMinYearReleases.length === 0) {
      continue;
    }

    for (const release of result.postMinYearReleases) {
      const row = [
        result.artist || DEFAULTS.ARTIST,
        result.title || DEFAULTS.TITLE,
        result.releaseId,
        release.year,
        release.title,
        release.id,
        release.url,
      ];
      csvRows.push(row.map(escapeCsvField).join(","));
    }
  }

  const csvContent = csvRows.join("\n");
  writeFileSync(outputPath, csvContent, "utf-8");
};

const generateOutputFilename = (): string => {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, "-").slice(0, -5); // Format: 2024-01-15T10-30-45
  return `${CSV_OUTPUT.FILENAME_PREFIX}${timestamp}.csv`;
};

const main = async () => {
  // Allow override via command line argument, otherwise use the constant
  const csvPath = process.argv[2] || WANTLIST_CSV_PATH;

  console.log(`Reading CSV file: ${csvPath}`);

  let rows: CsvRow[];
  try {
    rows = parseCsvFile(csvPath);
  } catch (error) {
    console.error(`Error reading CSV file: ${error}`);
    process.exit(1);
  }

  const releaseIds = extractReleaseIds(rows);
  console.log(`Found ${releaseIds.length} release IDs to process\n`);

  const client = getClient();
  const results: ReleaseInfo[] = [];
  const releasesWithPostMinYear: ReleaseInfo[] = [];

  const maxRequestsPerMin = isAuthenticated
    ? RATE_LIMIT.AUTHENTICATED_REQUESTS_PER_MINUTE
    : RATE_LIMIT.UNAUTHENTICATED_REQUESTS_PER_MINUTE;

  console.log(
    `\nRate limit: ${maxRequestsPerMin} requests/minute (${RATE_LIMIT.WINDOW_MS / 1000}-second sliding window)\n`
  );

  const startTime = Date.now();

  for (let i = 0; i < releaseIds.length; i++) {
    const { id, artist, title } = releaseIds[i];

    if (i > 0 && i % PROGRESS.REPORT_INTERVAL === 0) {
      const elapsed = Math.floor((Date.now() - startTime) / 1000 / 60);
      const requestsInWindow = rateLimiter.getRequestsInWindow();
      const remaining = rateLimiter.getRemaining();
      console.log(
        `Processed ${i}/${releaseIds.length} releases... (${elapsed} min elapsed, ${requestsInWindow}/${maxRequestsPerMin} requests in window, ${remaining} remaining)`
      );
    }

    const result = await checkReleaseForPostMinYearVersions(client, id, artist, title);
    results.push(result);

    if (result.hasPostMinYearRelease) {
      releasesWithPostMinYear.push(result);
    }
  }

  console.log(`\n\n=== Results ===`);
  console.log(`Total releases processed: ${results.length}`);
  console.log(`Releases with ${MIN_YEAR}+ versions: ${releasesWithPostMinYear.length}\n`);

  if (releasesWithPostMinYear.length > 0) {
    // Write results to CSV
    const outputFilename = generateOutputFilename();
    const outputPath = join(process.cwd(), outputFilename);
    writeResultsToCsv(releasesWithPostMinYear, outputPath);
    console.log(`✅ Results saved to: ${outputFilename}\n`);

    console.log(`Releases with ${MIN_YEAR}+ versions:\n`);
    releasesWithPostMinYear.forEach((result) => {
      console.log(`\n${result.artist} - ${result.title}`);
      console.log(`  Release ID: ${result.releaseId}`);
      console.log(`  ${MIN_YEAR}+ releases (${result.postMinYearReleases.length}):`);
      result.postMinYearReleases.forEach((release) => {
        console.log(`    - [${release.year}] ${release.title} (ID: ${release.id})`);
        console.log(`      URL: ${release.url}`);
      });
    });
  } else {
    console.log(`No releases found with ${MIN_YEAR}+ versions.`);
  }
};

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
