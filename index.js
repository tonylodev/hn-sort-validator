const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const {
  escapeHtml,
  evaluateValidationRun,
  parseHackerNewsTimestamp,
  safeReportUrl,
} = require("./lib/validation");

const REQUIRED_ARTICLE_COUNT = 100;
const PAGINATION_DELAY_MS = 5000;
const RATE_LIMIT_RETRY_MS = 30000;
const MAX_NAVIGATION_ATTEMPTS = 4;
const MAX_COLLECTION_PAGES = 10;

async function navigateWithRetry(
  page,
  url,
  {
    maxAttempts = MAX_NAVIGATION_ATTEMPTS,
    retryDelayMs = RATE_LIMIT_RETRY_MS,
  } = {}
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await page.goto(url, { waitUntil: "domcontentloaded" });
    const status = response?.status();

    if (status === 429) {
      if (attempt === maxAttempts) {
        throw new Error(
          `Hacker News rate limit persisted after ${maxAttempts} attempts.`
        );
      }

      console.log(
        `Hacker News rate limited the request; retrying in ${retryDelayMs / 1000} seconds.`
      );
      await page.waitForTimeout(retryDelayMs);
      continue;
    }

    if (!response || !response.ok()) {
      throw new Error(
        `Hacker News request failed${status ? ` with HTTP ${status}` : ""}.`
      );
    }

    await page.waitForSelector("tr.athing");
    return response;
  }
}

async function readArticleRows(page) {
  const rows = await page.$$("tr.athing");

  return Promise.all(
    rows.map(async (row) => {
      const id = await row.getAttribute("id");
      if (!id) {
        throw new Error("Hacker News returned an article without an item ID.");
      }

      const rank = await row.$eval("span.rank", (element) =>
        element.textContent.trim()
      );
      const { title, url } = await row.$eval(
        "span.titleline > a",
        (element) => ({
          title: element.textContent.trim(),
          url: element.href,
        })
      );
      const subtextRow = await row.evaluateHandle(
        (element) => element.nextElementSibling
      );
      const ageSpan = await subtextRow.$("span.age");
      const timestampRaw = await ageSpan?.getAttribute("title");
      const { dateStr, timestamp } = parseHackerNewsTimestamp(timestampRaw);

      return {
        id,
        rank: parseInt(rank, 10),
        title,
        url,
        dateStr,
        timestamp,
      };
    })
  );
}

function appendUniqueArticles(
  articles,
  candidates,
  seenArticleIds,
  requiredCount = REQUIRED_ARTICLE_COUNT
) {
  for (const candidate of candidates) {
    if (!candidate.id) {
      throw new TypeError("Every article must have an item ID.");
    }

    if (seenArticleIds.has(candidate.id)) continue;

    seenArticleIds.add(candidate.id);
    articles.push(candidate);

    if (articles.length >= requiredCount) break;
  }
}

async function collectHackerNewsArticles(
  page,
  { paginationDelayMs = PAGINATION_DELAY_MS, maxPages = MAX_COLLECTION_PAGES } = {}
) {
  if (!Number.isInteger(maxPages) || maxPages < 1) {
    throw new TypeError("Maximum page count must be a positive integer.");
  }
  if (!Number.isFinite(paginationDelayMs) || paginationDelayMs < 0) {
    throw new TypeError("Pagination delay must be a non-negative number.");
  }

  const articles = [];
  const seenArticleIds = new Set();
  const visitedUrls = new Set();
  let nextUrl = "https://news.ycombinator.com/newest";

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    visitedUrls.add(nextUrl);
    await navigateWithRetry(page, nextUrl);
    const currentUrl = new URL(page.url());
    currentUrl.hash = "";
    visitedUrls.add(currentUrl.href);

    const previousCount = articles.length;
    appendUniqueArticles(articles, await readArticleRows(page), seenArticleIds);
    if (articles.length === REQUIRED_ARTICLE_COUNT) return articles;
    if (articles.length === previousCount) {
      throw new Error("Hacker News pagination returned no new unique articles.");
    }

    const moreLink = await page.$("a.morelink");
    const href = await moreLink?.getAttribute("href");
    if (!href) return articles;

    if (pageNumber === maxPages) {
      throw new Error(
        `Hacker News collection exceeded ${maxPages} pages before collecting ${REQUIRED_ARTICLE_COUNT} unique articles.`
      );
    }
    const moreUrl = new URL(href, page.url());
    moreUrl.hash = "";
    nextUrl = moreUrl.href;
    if (visitedUrls.has(nextUrl)) {
      throw new Error("Hacker News pagination repeated a page URL.");
    }
    await page.waitForTimeout(paginationDelayMs);
  }
}

async function sortHackerNewsArticles({ headless = true, openReport = false } = {}) {
  const browser = await chromium.launch({ headless });

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const articles = await collectHackerNewsArticles(page);
    console.log(`Collected ${articles.length} unique articles.\n`);

    const validation = evaluateValidationRun(articles, REQUIRED_ARTICLE_COUNT);
    const { collectionComplete, passed } = validation;

    if (passed) {
      console.log("PASS: The first 100 articles are sorted from newest to oldest.");
    } else {
      if (!collectionComplete) {
        console.log(
          `FAIL: Collected ${articles.length} articles; expected ${REQUIRED_ARTICLE_COUNT}.`
        );
      }

      if (!validation.sorted) {
        console.log("FAIL: Articles are NOT sorted correctly.");
        console.log(`Found ${validation.failures.length} out-of-order pair(s):\n`);

        for (const failure of validation.failures) {
          console.log(
            `  #${failure.current.rank} (${failure.current.dateStr}) should be newer than #${failure.next.rank} (${failure.next.dateStr})`
          );
        }
      }
    }

    const reportPath = buildReport(articles, {
      passed,
      failures: validation.failures,
      comparisonCount: validation.comparisonCount,
    });
    console.log(`\nReport saved to: ${reportPath}`);

    if (openReport) {
      const reportPage = await context.newPage();
      await reportPage.goto("file:///" + reportPath.replace(/\\/g, "/"));
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }

    return { passed, collectionComplete, ...validation, reportPath };
  } finally {
    await browser.close();
  }
}

function buildReport(
  articles,
  { passed, failures, comparisonCount },
  {
    outputPath = path.resolve(__dirname, "report.html"),
    generatedAt = new Date(),
  } = {}
) {
  const failedIndices = new Set(failures.map((failure) => failure.index));
  const passCount = comparisonCount - failures.length;
  const tableRows = articles
    .map((article, index) => {
      const isLast = index === articles.length - 1;
      const failed = failedIndices.has(index + 1);
      const status = isLast ? "Not compared" : failed ? "Out of order" : "OK";
      const rowClass = failed ? "fail" : isLast ? "" : "pass";
      const safeUrl = safeReportUrl(article.url);
      const title = safeUrl
        ? `<a href="${escapeHtml(safeUrl)}">${escapeHtml(article.title)}</a>`
        : escapeHtml(article.title);

      return `
      <tr class="${rowClass}">
        <td>${article.rank}</td>
        <td>${title}</td>
        <td>${escapeHtml(article.dateStr)}</td>
        <td>${status}</td>
      </tr>`;
    })
    .join("");

  const now = generatedAt.toLocaleString();
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>HN Sort Validation Report</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
      background: #f5f5f5;
      color: #333;
      padding: 30px;
    }
    .container { max-width: 960px; margin: 0 auto; }
    h1 { font-size: 22px; margin-bottom: 6px; }
    .meta { color: #666; font-size: 13px; margin-bottom: 20px; }
    .summary { display: flex; gap: 16px; margin-bottom: 24px; }
    .card {
      background: #fff;
      border-radius: 6px;
      padding: 16px 24px;
      border: 1px solid #ddd;
      flex: 1;
    }
    .card .label {
      font-size: 12px;
      color: #666;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .card .value { font-size: 28px; font-weight: 600; margin-top: 4px; }
    .result-pass .value { color: #1a7f37; }
    .result-fail .value { color: #cf222e; }
    .table-wrap { overflow-x: auto; }
    table {
      width: 100%;
      border-collapse: collapse;
      background: #fff;
      border: 1px solid #ddd;
      font-size: 14px;
    }
    th {
      background: #f0f0f0;
      text-align: left;
      padding: 10px 14px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #555;
      border-bottom: 1px solid #ddd;
    }
    td { padding: 8px 14px; border-bottom: 1px solid #eee; }
    a { color: #0969da; }
    a:focus-visible { outline: 2px solid #0969da; outline-offset: 2px; }
    tr.fail td { background: #fff5f5; }
    tr.fail td:last-child { color: #cf222e; font-weight: 600; }
    tr.pass td:last-child { color: #1a7f37; }
    @media (max-width: 640px) {
      body { padding: 16px; }
      .summary { flex-direction: column; }
    }
  </style>
</head>
<body>
  <main class="container">
    <h1>Hacker News Sort Validation Report</h1>
    <p class="meta">Generated on ${now}</p>

    <div class="summary">
      <div class="card ${passed ? "result-pass" : "result-fail"}">
        <div class="label">Result</div>
        <div class="value">${passed ? "PASS" : "FAIL"}</div>
      </div>
      <div class="card">
        <div class="label">Articles Checked</div>
        <div class="value">${articles.length}</div>
      </div>
      <div class="card">
        <div class="label">Pairs In Order</div>
        <div class="value">${passCount} / ${comparisonCount}</div>
      </div>
    </div>

    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Title</th>
            <th scope="col">Timestamp</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>${tableRows}
        </tbody>
      </table>
    </div>
  </main>
</body>
</html>`;

  fs.writeFileSync(outputPath, html, "utf8");
  return outputPath;
}

if (require.main === module) {
  const args = new Set(process.argv.slice(2));

  sortHackerNewsArticles({
    headless: !args.has("--headed"),
    openReport: args.has("--open-report"),
  })
    .then(({ passed }) => {
      if (!passed) process.exitCode = 1;
    })
    .catch((error) => {
      console.error(`ERROR: ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = {
  appendUniqueArticles,
  buildReport,
  collectHackerNewsArticles,
  navigateWithRetry,
  readArticleRows,
  sortHackerNewsArticles,
};
