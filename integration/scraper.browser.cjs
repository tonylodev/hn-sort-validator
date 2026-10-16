const { before, after, test } = require("node:test");
const assert = require("node:assert/strict");
const { chromium } = require("playwright");
const { collectHackerNewsArticles } = require("../index");
const { evaluateValidationRun } = require("../lib/validation");

// Synthetic HN-shaped markup: no saved user submissions or live-site requests.
function fixture(first, last, more, { timestamp = true, itemId = true } = {}) {
  const rows = [];
  for (let id = first; id <= last; id += 1) {
    const seconds = 1704067200 - id;
    const date = new Date(seconds * 1000).toISOString().slice(0, 19);
    rows.push(`<tr class="athing" ${itemId ? `id="${id}"` : ""}>
      <td><span class="rank">${id}.</span></td>
      <td><span class="titleline"><a href="https://example.com/${id}">Fixture article ${id}</a></span></td>
    </tr><tr><td><span class="age" title="${timestamp ? `${date} ${seconds}` : "invalid"}">just now</span></td></tr>`);
  }
  return `<!doctype html><html lang="en"><title>Synthetic feed</title><body>
    <table>${rows.join("")}</table>${more ? `<a class="morelink" href="${more}">More</a>` : ""}
  </body></html>`;
}

let browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

async function withFeed(pages, check) {
  const context = await browser.newContext();
  const requests = [];
  // Every request is intercepted, including unexpected destinations.
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const key = url.pathname + url.search;
    requests.push(key);
    if (url.origin !== "https://news.ycombinator.com" || !pages[key]) {
      await route.abort();
      return;
    }
    await route.fulfill({ contentType: "text/html", body: pages[key] });
  });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(3000);
    await check(page, requests);
  } finally {
    await context.close();
  }
}

test("reads real DOM rows and collects exactly 100 unique articles across overlapping pages", async () => {
  await withFeed({
    "/newest": fixture(1, 30, "newest?p=2"),
    "/newest?p=2": fixture(29, 58, "newest?p=3"),
    "/newest?p=3": fixture(57, 86, "newest?p=4"),
    "/newest?p=4": fixture(85, 114),
  }, async (page, requests) => {
    const articles = await collectHackerNewsArticles(page, { paginationDelayMs: 0, maxPages: 4 });
    assert.equal(articles.length, 100);
    assert.equal(new Set(articles.map(({ id }) => id)).size, 100);
    assert.equal(articles[0].title, "Fixture article 1");
    assert.equal(articles[0].url, "https://example.com/1");
    assert.equal(articles[99].rank, 100);
    assert.equal(evaluateValidationRun(articles, 100).passed, true);
    assert.equal(requests.length, 4);
  });
});

test("rejects a cyclic More link before requesting the same page again", async () => {
  await withFeed({
    "/newest": fixture(1, 2, "newest?p=2"),
    "/newest?p=2": fixture(3, 4, "/newest#top"),
  }, async (page, requests) => {
    await assert.rejects(
      collectHackerNewsArticles(page, { paginationDelayMs: 0 }),
      /pagination repeated a page URL/
    );
    assert.deepEqual(requests, ["/newest", "/newest?p=2"]);
  });
});

test("rejects duplicate-only pages even when the URL changes", async () => {
  await withFeed({
    "/newest": fixture(1, 2, "newest?p=2"),
    "/newest?p=2": fixture(1, 2, "newest?p=3"),
  }, async (page, requests) => {
    await assert.rejects(
      collectHackerNewsArticles(page, { paginationDelayMs: 0 }),
      /no new unique articles/
    );
    assert.equal(requests.length, 2);
  });
});

test("caps collection even when every page adds new articles and a new URL", async () => {
  await withFeed({
    "/newest": fixture(1, 2, "newest?p=2"),
    "/newest?p=2": fixture(3, 4, "newest?p=3"),
  }, async (page, requests) => {
    await assert.rejects(
      collectHackerNewsArticles(page, { paginationDelayMs: 0, maxPages: 2 }),
      /exceeded 2 pages before collecting 100 unique articles/
    );
    assert.equal(requests.length, 2);
  });
});

test("returns an incomplete collection when the feed ends without a More link", async () => {
  await withFeed({ "/newest": fixture(1, 2) }, async (page) => {
    const articles = await collectHackerNewsArticles(page, { paginationDelayMs: 0 });
    assert.equal(articles.length, 2);
    assert.equal(evaluateValidationRun(articles, 100).passed, false);
  });
});

test("rejects malformed timestamp markup from the browser", async () => {
  await withFeed({ "/newest": fixture(1, 2, null, { timestamp: false }) }, async (page) => {
    await assert.rejects(collectHackerNewsArticles(page), /Invalid Hacker News timestamp/);
  });
});

test("rejects a missing article ID from the browser", async () => {
  await withFeed({ "/newest": fixture(1, 2, null, { itemId: false }) }, async (page) => {
    await assert.rejects(collectHackerNewsArticles(page), /without an item ID/);
  });
});
