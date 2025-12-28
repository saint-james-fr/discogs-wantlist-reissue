# Discogs Wantlist Checker

A simple script to check if a Discogs release's master has any versions released after 2015.

## Setup

1. Install dependencies:
```bash
yarn install
```

2. Set up authentication (recommended for better rate limits):

```bash
export DISCOGS_USER_TOKEN="your_user_token_here"
```

You can get your Personal Access Token from [Discogs Developer Settings](https://www.discogs.com/settings/developers).

**Note:** Authentication is optional but recommended. Without it, you'll be limited to 25 requests/minute instead of 60 requests/minute.

## Usage

Run the script to process all releases from the CSV file:

```bash
yarn start
```

Or specify a custom CSV file path:

```bash
yarn start /path/to/wantlist.csv
```

The script will:
1. Parse the `wantlist.csv` file to extract all release IDs
2. For each release:
   - Fetch the release details
   - Find the master release ID
   - Get all versions of the master release
   - Check if any versions were released after 2015
3. Display a summary of all releases with post-2015 versions

## Output

The script will show:
- Total number of releases processed
- Number of releases with post-2015 versions
- Detailed list of each release with post-2015 versions, including:
  - Artist and title from the CSV
  - Release ID
  - List of post-2015 releases with year, title, and ID

## Notes

- The script includes a small delay between API calls to respect Discogs rate limits
- Progress is shown every 10 releases processed
- Errors for individual releases are caught and logged but won't stop the entire process

