const ARXIV_API_BASE = "https://export.arxiv.org/api/query";
const CACHE_KEY = "paperCache";
const MAX_CACHE_ITEMS = 100;

chrome.omnibox.setDefaultSuggestion({
  description: "Open arXiv PDF for: %s",
});

chrome.omnibox.onInputChanged.addListener(async (text, suggest) => {
  const query = normalizeQuery(text);

  if (!query) {
    suggest([]);
    return;
  }

  const cached = await findCachedPaper(query);

  if (!cached) {
    suggest([
      {
        content: text,
        description: `Search arXiv and open the best PDF match for: ${escapeDescription(text)}`,
      },
    ]);
    return;
  }

  suggest([
    {
      content: cached.title || text,
      description: `Open cached arXiv PDF: ${escapeDescription(cached.title || cached.id)}`,
    },
    {
      content: text,
      description: `Search arXiv again for: ${escapeDescription(text)}`,
    },
  ]);
});

chrome.omnibox.onInputEntered.addListener((text, disposition) => {
  openPaperFromQuery(text, disposition).catch((error) => {
    console.error("arXiv Quick PDF failed:", error);
    openUrl(buildGoogleFallbackUrl(text), disposition);
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "resolve-paper-query") {
    return false;
  }

  resolvePaperFromQuery(message.query)
    .then(async (paper) => {
      if (paper) {
        await saveCacheItem(paper);
      }

      sendResponse({ paper });
    })
    .catch((error) => {
      console.error("Failed to resolve paper query:", error);
      sendResponse({ error: error.message });
    });

  return true;
});

async function openPaperFromQuery(text, disposition) {
  const query = normalizeQuery(text);

  if (!query) {
    await openUrl("https://arxiv.org/", disposition);
    return;
  }

  const paper = await resolvePaperFromQuery(query);

  if (paper) {
    await saveCacheItem(paper);
    await openUrl(paper.pdfUrl, disposition);
    return;
  }

  await openUrl(buildGoogleFallbackUrl(query), disposition);
}

async function resolvePaperFromQuery(text) {
  const query = normalizeQuery(text);

  if (!query) {
    return null;
  }

  const cached = await findCachedPaper(query);

  if (cached) {
    const historyVersion = await findHistoryVersionForId(cached.id);
    const id = historyVersion || cached.id;

    return {
      ...cached,
      id,
      pdfUrl: toPdfUrl(id),
      source: "cache",
    };
  }

  const historyHit = await findPaperInHistory(query);

  if (historyHit) {
    return historyHit;
  }

  const arxivHit = await searchArxiv(query);

  if (arxivHit) {
    const historyVersion = await findHistoryVersionForId(arxivHit.id);
    const id = historyVersion || arxivHit.id;

    return {
      ...arxivHit,
      id,
      pdfUrl: toPdfUrl(id),
    };
  }

  return null;
}

async function findPaperInHistory(query) {
  const items = await chrome.history.search({
    text: query,
    maxResults: 50,
    startTime: 0,
  });

  const arxivItem = items.find((item) => extractArxivId(item.url || ""));

  if (!arxivItem) {
    return null;
  }

  const id = extractArxivId(arxivItem.url);
  const title = cleanHistoryTitle(arxivItem.title) || query;

  return {
    id,
    title,
    pdfUrl: toPdfUrl(id),
    score: 1,
    source: "history",
  };
}

async function findHistoryVersionForId(id) {
  const baseId = stripVersion(id);
  const items = await chrome.history.search({
    text: baseId,
    maxResults: 20,
    startTime: 0,
  });

  for (const item of items) {
    const historyId = extractArxivId(item.url || "");

    if (historyId && stripVersion(historyId) === baseId) {
      return historyId;
    }
  }

  return null;
}

async function searchArxiv(query) {
  const entries = await fetchArxivEntries(`ti:"${escapeArxivQuery(query)}"`, 5);
  let candidates = entries;

  if (!candidates.length) {
    candidates = await fetchArxivEntries(query, 5);
  }

  const ranked = candidates
    .map((entry) => ({
      ...entry,
      score: scoreTitleMatch(query, entry.title),
    }))
    .sort((left, right) => right.score - left.score);

  const best = ranked[0];

  if (!best || best.score < 0.28) {
    return null;
  }

  return {
    id: best.id,
    title: best.title,
    pdfUrl: toPdfUrl(best.id),
    score: best.score,
    source: "arxiv",
  };
}

async function fetchArxivEntries(searchQuery, maxResults) {
  const url = new URL(ARXIV_API_BASE);
  url.searchParams.set("search_query", searchQuery);
  url.searchParams.set("start", "0");
  url.searchParams.set("max_results", String(maxResults));

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`arXiv API returned ${response.status}`);
  }

  return parseArxivFeed(await response.text());
}

function parseArxivFeed(xml) {
  const entryMatches = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];

  return entryMatches
    .map((entryXml) => {
      const idUrl = getXmlTagText(entryXml, "id");
      const id = extractArxivId(idUrl);
      const title = normalizeWhitespace(getXmlTagText(entryXml, "title"));

      if (!id || !title) {
        return null;
      }

      return {
        id,
        title,
        pdfUrl: toPdfUrl(id),
      };
    })
    .filter(Boolean);
}

function getXmlTagText(xml, tagName) {
  const match = xml.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return match ? decodeXmlEntities(match[1]) : "";
}

function decodeXmlEntities(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function findCachedPaper(query) {
  const cache = await getCache();
  const queryKey = toSearchKey(query);

  return (
    cache.find((item) => toSearchKey(item.title) === queryKey) ||
    cache.find((item) => {
      const titleKey = toSearchKey(item.title);
      return titleKey.includes(queryKey) || queryKey.includes(titleKey);
    }) ||
    null
  );
}

async function saveCacheItem(item) {
  const cache = await getCache();
  const baseId = stripVersion(item.id);
  const nextItem = {
    id: item.id,
    title: item.title,
    pdfUrl: item.pdfUrl || toPdfUrl(item.id),
    source: item.source,
    lastUsedAt: Date.now(),
  };
  const nextCache = [
    nextItem,
    ...cache.filter((cached) => stripVersion(cached.id) !== baseId),
  ].slice(0, MAX_CACHE_ITEMS);

  await chrome.storage.local.set({ [CACHE_KEY]: nextCache });
}

async function touchCacheItem(item) {
  await saveCacheItem({
    ...item,
    lastUsedAt: Date.now(),
  });
}

async function getCache() {
  const stored = await chrome.storage.local.get(CACHE_KEY);
  return Array.isArray(stored[CACHE_KEY]) ? stored[CACHE_KEY] : [];
}

async function openUrl(url, disposition) {
  if (disposition === "currentTab") {
    const [activeTab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (activeTab?.id) {
      await chrome.tabs.update(activeTab.id, { url });
      return;
    }
  }

  await chrome.tabs.create({
    url,
    active: disposition !== "newBackgroundTab",
  });
}

function extractArxivId(rawUrl) {
  if (!rawUrl) {
    return null;
  }

  try {
    const url = new URL(rawUrl);
    const host = url.hostname.toLowerCase();

    if (!host.endsWith("arxiv.org")) {
      return null;
    }

    const parts = url.pathname.split("/").filter(Boolean);
    const section = parts[0];

    if (!["abs", "pdf", "html"].includes(section) || parts.length < 2) {
      return null;
    }

    return parts.slice(1).join("/").replace(/\.pdf$/i, "");
  } catch (_error) {
    const match = rawUrl.match(/arxiv\.org\/(?:abs|pdf|html)\/([^?#\s]+)/i);
    return match ? match[1].replace(/\.pdf$/i, "") : null;
  }
}

function toPdfUrl(id) {
  return `https://arxiv.org/pdf/${id}`;
}

function stripVersion(id) {
  return id.replace(/v\d+$/i, "");
}

function cleanHistoryTitle(title) {
  return normalizeWhitespace(
    (title || "")
      .replace(/\s*-\s*arXiv.*$/i, "")
      .replace(/\s*\|\s*arXiv.*$/i, "")
  );
}

function scoreTitleMatch(query, title) {
  const queryKey = toSearchKey(query);
  const titleKey = toSearchKey(title);

  if (!queryKey || !titleKey) {
    return 0;
  }

  if (titleKey === queryKey) {
    return 1;
  }

  if (titleKey.includes(queryKey)) {
    return 0.9;
  }

  const queryTokens = new Set(queryKey.split(" ").filter((token) => token.length > 2));
  const titleTokens = new Set(titleKey.split(" ").filter((token) => token.length > 2));

  if (!queryTokens.size || !titleTokens.size) {
    return 0;
  }

  let overlap = 0;

  for (const token of queryTokens) {
    if (titleTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap / Math.max(queryTokens.size, titleTokens.size);
}

function normalizeQuery(text) {
  return normalizeWhitespace(text).trim();
}

function normalizeWhitespace(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function toSearchKey(text) {
  return normalizeWhitespace(text)
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function escapeArxivQuery(query) {
  return query.replace(/"/g, " ").trim();
}

function escapeDescription(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildGoogleFallbackUrl(query) {
  return `https://www.google.com/search?q=${encodeURIComponent(`${query} arxiv`)}`;
}
