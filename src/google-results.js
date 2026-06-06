(function enhanceGoogleForArxiv() {
  const processedLinks = new WeakSet();
  const boundInputs = new WeakSet();
  const boundForms = new WeakSet();
  const suggestion = {
    debounceId: 0,
    hit: null,
    input: null,
    panel: null,
    query: "",
    requestId: 0,
  };
  let topPdfUrl = "";
  let scheduled = false;

  scanPage();

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  document.addEventListener("keydown", (event) => {
    if (
      topPdfUrl &&
      event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      event.key.toLowerCase() === "p" &&
      !isEditable(event.target)
    ) {
      event.preventDefault();
      window.location.assign(topPdfUrl);
    }
  });

  function scheduleScan() {
    if (scheduled) {
      return;
    }

    scheduled = true;
    window.setTimeout(() => {
      scheduled = false;
      scanPage();
    }, 150);
  }

  function scanPage() {
    bindSearchInputs();
    scanResults();
  }

  function bindSearchInputs() {
    const inputs = document.querySelectorAll('textarea[name="q"], input[name="q"]');

    for (const input of inputs) {
      if (!boundInputs.has(input)) {
        boundInputs.add(input);
        input.addEventListener("input", () => scheduleResolve(input));
        input.addEventListener("focus", () => scheduleResolve(input));
        input.addEventListener("keydown", (event) => handleSearchInputKeydown(event, input), true);
      }

      const form = input.closest("form");

      if (form && !boundForms.has(form)) {
        boundForms.add(form);
        form.addEventListener("submit", (event) => handleSearchSubmit(event, input), true);
      }
    }
  }

  function scheduleResolve(input) {
    const query = normalizeWhitespace(input.value);
    window.clearTimeout(suggestion.debounceId);
    suggestion.input = input;

    if (!shouldResolveQuery(query)) {
      hideSuggestion();
      return;
    }

    if (suggestion.hit && suggestion.query === query) {
      showSuggestion(input, suggestion.hit, query);
      return;
    }

    suggestion.query = query;
    suggestion.debounceId = window.setTimeout(() => {
      resolveInputQuery(input, query);
    }, 420);
  }

  async function resolveInputQuery(input, query) {
    const requestId = ++suggestion.requestId;

    try {
      const response = await chrome.runtime.sendMessage({
        type: "resolve-paper-query",
        query,
      });

      if (requestId !== suggestion.requestId || normalizeWhitespace(input.value) !== query) {
        return;
      }

      if (response?.paper) {
        showSuggestion(input, response.paper, query);
      } else {
        hideSuggestion();
      }
    } catch (_error) {
      if (requestId === suggestion.requestId) {
        hideSuggestion();
      }
    }
  }

  function showSuggestion(input, paper, query) {
    suggestion.hit = paper;
    suggestion.input = input;
    suggestion.query = query;

    const panel = suggestion.panel || document.createElement("div");
    panel.className = "arxiv-quick-pdf-search-suggestion";

    const link = panel.querySelector("a") || document.createElement("a");
    link.className = "arxiv-quick-pdf-search-link";
    link.href = paper.pdfUrl;
    link.rel = "noopener noreferrer";
    link.textContent = "Open arXiv PDF";

    const title = panel.querySelector("span") || document.createElement("span");
    title.className = "arxiv-quick-pdf-search-title";
    title.textContent = paper.title || paper.id || "";

    if (!link.parentElement) {
      panel.append(link, title);
    }

    suggestion.panel = panel;

    if (!panel.parentElement) {
      const form = input.closest("form");
      const target = form || input;
      target.insertAdjacentElement("afterend", panel);
    }
  }

  function hideSuggestion() {
    suggestion.hit = null;
    suggestion.query = "";
    suggestion.panel?.remove();
  }

  function handleSearchInputKeydown(event, input) {
    if (event.key === "Escape") {
      hideSuggestion();
      return;
    }

    if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
      return;
    }

    openSuggestionFromInput(event, input);
  }

  function handleSearchSubmit(event, input) {
    openSuggestionFromInput(event, input);
  }

  function openSuggestionFromInput(event, input) {
    if (!canDirectOpen(input)) {
      return false;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    window.location.assign(suggestion.hit.pdfUrl);
    return true;
  }

  function canDirectOpen(input) {
    const query = normalizeWhitespace(input.value);

    if (!suggestion.hit || suggestion.input !== input || suggestion.query !== query) {
      return false;
    }

    if (suggestion.hit.source === "history" || suggestion.hit.source === "cache") {
      return true;
    }

    const score = Number(suggestion.hit.score || 0);
    const tokenCount = toSearchTokens(query).length;

    return score >= 0.55 || (score >= 0.35 && tokenCount >= 3);
  }

  function scanResults() {
    const links = document.querySelectorAll("a[href]");
    const hits = [];

    for (const link of links) {
      if (link.closest(".arxiv-quick-pdf-top, .arxiv-quick-pdf-actions")) {
        continue;
      }

      const arxivId = extractArxivId(unwrapGoogleUrl(link.href));

      if (!arxivId) {
        continue;
      }

      const pdfUrl = toPdfUrl(arxivId);
      hits.push({
        link,
        pdfUrl,
        title: getResultTitle(link),
      });

      if (processedLinks.has(link)) {
        continue;
      }

      processedLinks.add(link);
      insertPdfButton(link, pdfUrl);
    }

    updateTopAction(findPrimaryHit(hits));
  }

  function insertPdfButton(link, pdfUrl) {
    const resultBlock = link.closest("div.g, div.MjjYud, div[data-sokoban-container]") || link.parentElement;

    if (!resultBlock || hasPdfButton(resultBlock, pdfUrl)) {
      return;
    }

    const actions = resultBlock.querySelector(".arxiv-quick-pdf-actions") || document.createElement("div");
    actions.className = "arxiv-quick-pdf-actions";

    const button = document.createElement("a");
    button.className = "arxiv-quick-pdf-link";
    button.href = pdfUrl;
    button.textContent = "Open PDF";
    button.rel = "noopener noreferrer";

    actions.appendChild(button);

    if (!actions.parentElement) {
      const heading = resultBlock.querySelector("h3");
      const anchor = heading?.closest("a") || link;
      anchor.insertAdjacentElement("afterend", actions);
    }
  }

  function updateTopAction(hit) {
    const existing = document.querySelector(".arxiv-quick-pdf-top");

    if (!hit) {
      existing?.remove();
      topPdfUrl = "";
      return;
    }

    topPdfUrl = hit.pdfUrl;

    const topAction = existing || document.createElement("div");
    topAction.className = "arxiv-quick-pdf-top";

    const link = topAction.querySelector("a") || document.createElement("a");
    link.className = "arxiv-quick-pdf-top-link";
    link.href = hit.pdfUrl;
    link.rel = "noopener noreferrer";
    link.title = "Alt+P";
    link.textContent = "Open first arXiv PDF";

    const title = topAction.querySelector("span") || document.createElement("span");
    title.className = "arxiv-quick-pdf-top-title";
    title.textContent = hit.title || "";

    if (!link.parentElement) {
      topAction.append(link, title);
    }

    if (!existing) {
      const resultList = document.querySelector("#search") || document.querySelector("#rso");
      resultList?.insertAdjacentElement("beforebegin", topAction);
    }
  }

  function findPrimaryHit(hits) {
    return (
      hits.find((hit) => hit.link.querySelector("h3")) ||
      hits.find((hit) => hit.link.closest("div.g, div.MjjYud")) ||
      hits[0] ||
      null
    );
  }

  function getResultTitle(link) {
    return normalizeWhitespace(link.querySelector("h3")?.textContent || link.textContent);
  }

  function unwrapGoogleUrl(rawUrl) {
    try {
      const url = new URL(rawUrl);

      if (url.pathname === "/url" && url.searchParams.has("q")) {
        return url.searchParams.get("q") || rawUrl;
      }

      return rawUrl;
    } catch (_error) {
      return rawUrl;
    }
  }

  function extractArxivId(rawUrl) {
    if (!rawUrl) {
      return null;
    }

    try {
      const url = new URL(rawUrl);

      if (!url.hostname.toLowerCase().endsWith("arxiv.org")) {
        return null;
      }

      const parts = url.pathname.split("/").filter(Boolean);

      if (!["abs", "pdf"].includes(parts[0]) || parts.length < 2) {
        return null;
      }

      return parts.slice(1).join("/").replace(/\.pdf$/i, "");
    } catch (_error) {
      const match = rawUrl.match(/arxiv\.org\/(?:abs|pdf)\/([^?#\s]+)/i);
      return match ? match[1].replace(/\.pdf$/i, "") : null;
    }
  }

  function toPdfUrl(id) {
    return `https://arxiv.org/pdf/${id}`;
  }

  function hasPdfButton(resultBlock, pdfUrl) {
    return Array.from(resultBlock.querySelectorAll(".arxiv-quick-pdf-link")).some(
      (button) => button.href === pdfUrl
    );
  }

  function shouldResolveQuery(query) {
    return normalizeWhitespace(query).length >= 4;
  }

  function isEditable(element) {
    return Boolean(
      element?.closest?.("input, textarea, select, [contenteditable=''], [contenteditable='true']")
    );
  }

  function toSearchTokens(text) {
    return normalizeWhitespace(text)
      .toLowerCase()
      .replace(/['"`]/g, "")
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  }

  function normalizeWhitespace(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }
})();
