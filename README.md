# arXiv Quick PDF

Chrome extension for opening arXiv PDFs directly from paper titles.

## Usage

1. Open `chrome://extensions/`.
2. Enable Developer mode.
3. Click **Load unpacked** and select this directory.
4. Open Google and start typing part of a paper title in the Google search box.
5. When the **Open arXiv PDF** suggestion appears under the search box, press Enter to open the PDF directly.

This works on the Google home page and Google search result pages. The extension checks your local Chrome history first, then arXiv.

## Search results

If you do land on a Google results page, the extension adds:

- **Open first arXiv PDF** above the results.
- **Open PDF** next to each arXiv result.
- `Alt+P` to open the first arXiv PDF on the results page.

## Address bar shortcut

For direct address-bar lookup, type `ax`, press Space or Tab, then enter a paper title.

Example:

```text
ax attention is all you need
```

The extension tries these steps in order:

1. Search your Chrome history for a matching arXiv page.
2. Search arXiv by title through `export.arxiv.org`.
3. Fall back to a Google search for the title plus `arxiv`.

Chrome extensions cannot read or intercept normal Chrome address-bar input without an omnibox keyword. The no-`ax` flow therefore runs inside Google's page search box, not the browser address bar.

## Permissions

- `history`: checks whether you previously opened a matching arXiv paper.
- `storage`: caches resolved paper titles and arXiv IDs for faster repeat opens.
- `tabs`: opens or updates the active tab with the resolved PDF.
- `https://arxiv.org/*` and `https://export.arxiv.org/*`: reads arXiv search results and opens PDFs.

The extension does not send your browser history anywhere. It only queries Chrome's local history API and the public arXiv API.
