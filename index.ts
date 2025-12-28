import { DiscogsClient } from "@lionralfs/discogs-client";
import { parse } from "csv-parse/sync";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type ReleaseInfo = {
  releaseId: number;
  artist?: string;
  title?: string;
  hasPost2015Release: boolean;
  post2015Releases: Array<{
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

// Rate limiter that tracks requests in a 60-second sliding window
class RateLimiter {
  private requestTimestamps: number[] = [];
  private maxRequests: number;
  private windowMs = 60000; // 60 seconds

  constructor(maxRequests: number) {
    this.maxRequests = maxRequests;
  }

  // Clean up old requests outside the 60-second window
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
    if (remaining <= 2) {
      // Calculate how long to wait until the oldest request falls out of the window
      if (this.requestTimestamps.length > 0) {
        const oldestRequest = this.requestTimestamps[0];
        const waitTime = this.windowMs - (Date.now() - oldestRequest) + 100; // Add 100ms buffer
        if (waitTime > 0) {
          console.log(`⏳ Rate limit: ${requestsInWindow}/${this.maxRequests} used. Waiting ${Math.ceil(waitTime / 1000)}s...`);
          await sleep(waitTime);
          this.cleanup();
        }
      } else {
        // Conservative delay if we don't have timing info
        await sleep(1000);
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
    rateLimiter = new RateLimiter(60); // Authenticated: 60 req/min
    return new DiscogsClient({
      userAgent: "wantlist-checker/1.0",
      auth: { userToken },
    });
  }

  // Fallback to unauthenticated client (limited to 25 requests/minute)
  isAuthenticated = false;
  rateLimiter = new RateLimiter(25); // Unauthenticated: 25 req/min
  console.warn(
    "⚠️  Warning: No authentication provided. Using unauthenticated mode (25 req/min limit).\n" +
      "   For better rate limits (60 req/min), set DISCOGS_USER_TOKEN environment variable.\n" +
      "   Get your token at: https://www.discogs.com/settings/developers\n"
  );
  return new DiscogsClient({
    userAgent: "wantlist-checker/1.0",
  });
};

const sleep = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

const checkReleaseForPost2015Versions = async (
  client: DiscogsClient,
  releaseId: number,
  artist?: string,
  title?: string,
  retryCount = 0
): Promise<ReleaseInfo> => {
  const maxRetries = 5;
  const baseDelay = 60000; // 1 minute base delay for rate limit errors

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
        return checkReleaseForPost2015Versions(client, releaseId, artist, title, retryCount + 1);
      }
      throw error;
    }

    const release = releaseResponse.data;

    if (!release.master_id) {
      return {
        releaseId,
        artist,
        title,
        hasPost2015Release: false,
        post2015Releases: [],
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
        return checkReleaseForPost2015Versions(client, releaseId, artist, title, retryCount + 1);
      }
      throw error;
    }

    const versions = masterVersionsResponse.data.versions || [];

    // Filter for releases from 2015 onwards (2015 included)
    const post2015Releases = versions
      .filter((version) => {
        // Check both year (number) and released (string date) fields
        const year = (version as any).year;
        const released = (version as any).released;

        if (year && typeof year === "number") {
          return year >= 2015;
        }

        // If released is a string, try to extract year
        if (released && typeof released === "string") {
          const yearMatch = released.match(/(\d{4})/);
          if (yearMatch) {
            const extractedYear = parseInt(yearMatch[1], 10);
            return extractedYear >= 2015;
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
          title: (version as any).title || "Unknown",
          year: releaseYear,
          url: `https://www.discogs.com/release/${version.id}`,
        };
      });

    return {
      releaseId,
      artist,
      title,
      hasPost2015Release: post2015Releases.length > 0,
      post2015Releases,
    };
  } catch (error: any) {
    if (error.statusCode === 429 && retryCount < maxRetries) {
      const delay = baseDelay * Math.pow(2, retryCount); // Exponential backoff
      console.log(
        `⚠️  Rate limit hit for release ${releaseId}. Waiting ${delay / 1000}s before retry ${retryCount + 1}/${maxRetries}...`
      );
      await sleep(delay);
      return checkReleaseForPost2015Versions(client, releaseId, artist, title, retryCount + 1);
    }

    console.error(`Error checking release ${releaseId}:`, error.message || error);
    // Return a result indicating error but don't throw
    return {
      releaseId,
      artist,
      title,
      hasPost2015Release: false,
      post2015Releases: [],
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
        artist: row.Artist || "Unknown",
        title: row.Title || "Unknown",
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
  const headers = [
    "Original Artist",
    "Original Title",
    "Original Release ID",
    "2015+ Release Year",
    "2015+ Release Title",
    "2015+ Release ID",
    "2015+ Release URL",
  ];

  const csvRows: string[] = [headers.map(escapeCsvField).join(",")];

  for (const result of results) {
    if (result.post2015Releases.length === 0) {
      continue;
    }

    for (const release of result.post2015Releases) {
      const row = [
        result.artist || "Unknown",
        result.title || "Unknown",
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
  return `wantlist-results-${timestamp}.csv`;
};

const main = async () => {
  const csvPath = process.argv[2] || join(process.cwd(), "wantlist.csv");

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
  const releasesWithPost2015: ReleaseInfo[] = [];

  console.log(
    `\nRate limit: ${isAuthenticated ? "60" : "25"} requests/minute (60-second sliding window)\n`
  );

  const startTime = Date.now();

  for (let i = 0; i < releaseIds.length; i++) {
    const { id, artist, title } = releaseIds[i];

    if (i > 0 && i % 10 === 0) {
      const elapsed = Math.floor((Date.now() - startTime) / 1000 / 60);
      const requestsInWindow = rateLimiter.getRequestsInWindow();
      const remaining = rateLimiter.getRemaining();
      console.log(
        `Processed ${i}/${releaseIds.length} releases... (${elapsed} min elapsed, ${requestsInWindow}/${isAuthenticated ? 60 : 25} requests in window, ${remaining} remaining)`
      );
    }

    const result = await checkReleaseForPost2015Versions(client, id, artist, title);
    results.push(result);

    if (result.hasPost2015Release) {
      releasesWithPost2015.push(result);
    }
  }

  console.log(`\n\n=== Results ===`);
  console.log(`Total releases processed: ${results.length}`);
  console.log(`Releases with 2015+ versions: ${releasesWithPost2015.length}\n`);

  if (releasesWithPost2015.length > 0) {
    // Write results to CSV
    const outputFilename = generateOutputFilename();
    const outputPath = join(process.cwd(), outputFilename);
    writeResultsToCsv(releasesWithPost2015, outputPath);
    console.log(`✅ Results saved to: ${outputFilename}\n`);

    console.log("Releases with 2015+ versions:\n");
    releasesWithPost2015.forEach((result) => {
      console.log(`\n${result.artist} - ${result.title}`);
      console.log(`  Release ID: ${result.releaseId}`);
      console.log(`  2015+ releases (${result.post2015Releases.length}):`);
      result.post2015Releases.forEach((release) => {
        console.log(`    - [${release.year}] ${release.title} (ID: ${release.id})`);
        console.log(`      URL: ${release.url}`);
      });
    });
  } else {
    console.log("No releases found with 2015+ versions.");
  }
};

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
