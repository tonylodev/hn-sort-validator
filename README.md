<div align="center">

# HN Sort Validator

**Automated QA check for Hacker News ordering, built with Playwright**

[![Unit tests](https://github.com/tonylodev/hn-sort-validator/actions/workflows/test.yml/badge.svg)](https://github.com/tonylodev/hn-sort-validator/actions/workflows/test.yml)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Playwright](https://img.shields.io/badge/Playwright-browser_automation-2EAD33?style=flat-square&logo=playwright)](https://playwright.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)](LICENSE)

</div>

## Overview

This command-line QA tool collects the first 100 unique items from Hacker
News's [`/newest`](https://news.ycombinator.com/newest) feed and verifies that
their timestamps are in descending order. It then writes a self-contained HTML
report with the overall result, pair-by-pair status, timestamps, and links to
the source articles.

The scraper handles a live, paginated feed rather than a static fixture. It
paces page requests, retries bounded HTTP 429 responses, and deduplicates items
by their stable Hacker News IDs when new submissions shift page boundaries.
Incomplete collection, invalid markup, HTTP errors, and ordering failures all
produce a non-zero process exit code.

## Quick start

### Prerequisites

- [Node.js](https://nodejs.org) 18 or newer

### Install

```bash
git clone https://github.com/tonylodev/hn-sort-validator.git
cd hn-sort-validator
npm ci
npx playwright install chromium
```

### Run the validator

```bash
npm run validate
```

The default run is headless and writes `report.html` in the project directory.
That generated file is ignored by Git. To watch the browser and briefly preview
the completed report, run:

```bash
npm run validate:headed
```

## Validation behavior

The command performs these checks:

1. Open the Hacker News newest feed and wait for article rows.
2. Collect article ID, rank, title, destination URL, and absolute timestamp.
3. Follow the `More` link with a five-second delay between pages.
4. Skip duplicate IDs caused by changes to the live feed while paging.
5. Require exactly 100 unique articles.
6. Verify every adjacent timestamp pair is newest-to-oldest.
7. Generate a safe HTML report and return success or failure to the shell.

HTTP 429 responses trigger a 30-second wait between attempts, with a bounded
maximum of four navigation attempts. Other unsuccessful HTTP responses fail
immediately with a clear status message.

## Report output

The generated report contains:

| Section | Purpose |
|---|---|
| Result | Overall `PASS` or `FAIL` |
| Articles checked | Number of unique items collected |
| Pairs in order | Successful adjacent comparisons |
| Article table | Rank, linked title, timestamp, and per-row status |

Article titles and URLs are escaped before insertion. Only HTTP and HTTPS links
are rendered as clickable links; unsupported URL schemes remain plain text.

## Tests and CI

```bash
npm test
```

The offline Node test suite covers:

- timestamp parsing and invalid input;
- descending, equal, incomplete, and out-of-order results;
- rate-limit retries and non-retryable HTTP failures;
- duplicate article IDs across page boundaries;
- safe URL handling and HTML escaping; and
- generated report content and file output.

GitHub Actions runs the suite on Node.js 20 and 24 for every push and pull
request. The live scrape remains a separate integration check because it
depends on the current Hacker News site and its rate limits.

## Project structure

```text
hn-sort-validator/
├── .github/workflows/test.yml  # Node.js CI matrix
├── lib/validation.js           # Parsing, ordering, and output-safety helpers
├── test/                       # Offline navigation, validation, and report tests
├── .gitignore                  # Generated report exclusion
├── index.js                    # Browser automation and report generation
├── package.json                # Commands and dependency declaration
├── package-lock.json           # Locked dependency graph
└── README.md                   # Setup, behavior, and test documentation
```

## Technical decisions

- **Absolute timestamps:** the validator uses the Unix timestamp in
  `span.age[title]`, not relative text such as “2 hours ago.”
- **Stable deduplication:** Hacker News item IDs prevent a moving feed from
  counting one submission twice across pages.
- **Bounded retries:** transient rate limiting is handled without allowing an
  unattended run to wait forever.
- **Offline unit tests:** core ordering, retry, deduplication, and report logic
  can be verified without a browser or network connection.

## License

This project is licensed under the MIT License. See [LICENSE](LICENSE).
