# Discogs Wantlist Checker

A simple script to check if a Discogs release's master has any versions released after a specified year (default: 2015).

## Requirements

- Node.js 22.x or higher
- Yarn 1.x or higher
- A Discogs API Personal Access Token

## Quick Start

### 1. Prepare your CSV file

Export your wantlist from Discogs to a CSV file.
Place your `wantlist.csv` file in the same directory as the script. The CSV should contain a `release_id` column with Discogs release IDs.

**To customize settings:** Edit the constants in `config.ts`:

- **Change CSV file path:** Modify `WANTLIST_CSV_PATH`
- **Change year threshold:** Modify `MIN_YEAR` (default: 2015)
- **Adjust rate limits:** Modify values in `RATE_LIMIT` object
- **Other settings:** See `config.ts` for all available options

Example:

```typescript
// In config.ts
export const MIN_YEAR = 2015; // Change to filter by different year
export const WANTLIST_CSV_PATH = join(process.cwd(), "my-wantlist.csv");
```

### 2. Set up environment variables

Create a `.env` file in the project root directory:

```bash
DISCOGS_USER_TOKEN=your_user_token_here
```

You can get your Personal Access Token from [Discogs Developer Settings](https://www.discogs.com/settings/developers).

**Note:** Authentication is optional but recommended. Without it, you'll be limited to 25 requests/minute instead of 60 requests/minute.

### 3. Install dependencies

```bash
yarn install
```

### 4. Run the script

```bash
yarn start
```

Or specify a custom CSV file path as a command-line argument:

```bash
yarn start /path/to/custom-wantlist.csv
```

The script will:

1. Parse the `wantlist.csv` file to extract all release IDs
2. For each release:
   - Fetch the release details
   - Find the master release ID
   - Get all versions of the master release
   - Check if any versions were released after the configured year (default: 2015)
3. Generate a results CSV file (e.g., `wantlist-results-2025-12-28T00-12-15.csv`)

## View Results

After the script completes, open `wantlist-viewer.html` in your web browser:

1. Simply double-click `wantlist-viewer.html` or open it in any modern web browser
2. Click "📁 Load CSV File" and select the generated results CSV file
3. Use the search box to filter results by artist, title, or year

The viewer is a standalone HTML file with no dependencies - no server needed!

## Output

The script will show:

- Total number of releases processed
- Number of releases with versions from the configured year onwards (default: 2015+)
- Detailed list of each release with matching versions, including:
  - Artist and title from the CSV
  - Release ID
  - List of matching releases with year, title, and ID

The results are also saved to a CSV file with a timestamp in the filename.

## Notes

- The script includes rate limiting to respect Discogs API limits
- Progress is shown every 10 releases processed. It can take a while to process all releases.
- Errors for individual releases are caught and logged but won't stop the entire process
- The viewer HTML file works completely offline - no internet connection needed to view results
