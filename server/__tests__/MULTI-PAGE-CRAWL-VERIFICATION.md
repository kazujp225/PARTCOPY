# Multi-Page Crawl Feature - Verification Checklist

## Feature Summary

When a URL is submitted via POST /api/extract, the worker should crawl that page AND
linked pages on the same domain (max 5 pages total). Auth-required pages (401/403/login
redirect) should be skipped. Each sub-page gets its own sections extracted.

---

## 1. Code Review Checklist

### 1.1 Type Safety

- [ ] New functions have proper TypeScript types (no `any` for parameters or returns)
- [ ] The `MAX_PAGES` constant is typed as `number` (not magic number inline)
- [ ] Link collection function returns `string[]`, not an untyped array
- [ ] The `page_count` field in `setCrawlRunStatus` is updated with the actual count (was hardcoded to `1`)
- [ ] Any new interfaces for multi-page results are exported from proper module
- [ ] `SourcePageRow.page_type` handles new values beyond `'home'` (e.g. `'subpage'`, `'linked'`)

### 1.2 Error Handling

- [ ] Individual sub-page failures do NOT fail the entire crawl job
- [ ] Sub-page timeout does not block remaining pages from being processed
- [ ] Browser crash during sub-page is caught and the remaining pages are still attempted
- [ ] Network errors on sub-pages are logged with the URL that failed
- [ ] If all sub-pages fail, the seed page sections are still saved successfully
- [ ] Auth detection errors (malformed URLs) are caught gracefully
- [ ] The retry logic in `processJob` still works correctly with multi-page state

### 1.3 Edge Cases

- [ ] Seed URL that returns 0 links works identically to current single-page behavior
- [ ] Seed URL that returns only auth/external links proceeds with just the seed page
- [ ] Duplicate links (same URL appearing in multiple anchor tags) are deduplicated
- [ ] URL normalization handles: trailing slashes, fragments, mixed case hostnames
- [ ] Links with query parameters are handled correctly
- [ ] Circular links (page A links to B, B links back to A) do not cause infinite loops
- [ ] Pages that redirect to already-visited URLs are not re-processed
- [ ] Very large pages with 1000+ links only process the first MAX_PAGES worth
- [ ] Sub-page that 30x-redirects to an auth page is detected and skipped
- [ ] Sub-page that 30x-redirects to a different domain is skipped

### 1.4 Resource Management

- [ ] Browser pages are closed after each sub-page is processed (avoid memory leak)
- [ ] Total timeout (SITE_TIMEOUT_MS = 180s) is shared across all pages OR extended proportionally
- [ ] Download timeout per sub-page is reasonable (no 150s for each of 5 pages = 750s total)
- [ ] The browser is still properly closed in the `finally` block even with multi-page
- [ ] Storage paths for sub-pages do not collide: `{site_id}/{job_id}/page_{n}/...`
- [ ] Memory usage: allAssets from 5 pages combined should not exceed reasonable limits

---

## 2. Database / Data Model Checks

- [ ] Each sub-page creates its own `source_pages` record with correct `crawl_run_id`
- [ ] Each sub-page's sections have the correct `page_id` (not the seed page's ID)
- [ ] `crawl_runs.page_count` is set to the actual number of pages crawled
- [ ] `crawl_runs.section_count` is the sum of sections across all pages
- [ ] `source_pages.page_type` differentiates home vs sub-pages
- [ ] `source_pages.path` contains the correct URL path for each sub-page
- [ ] Section `order_index` is page-local (resets per page) OR globally unique

---

## 3. API Contract Checks

### 3.1 POST /api/extract

- [ ] No breaking changes to request format (url, genre, tags)
- [ ] Response still returns `{ jobId, siteId, status: 'queued' }`
- [ ] No new required fields added to the request body

### 3.2 GET /api/jobs/:id

- [ ] `page_count` now reflects actual pages crawled (1-5 instead of always 1)
- [ ] `section_count` reflects total sections from all pages
- [ ] Status progression is still: queued -> claimed -> rendering -> parsed -> normalizing -> done

### 3.3 GET /api/jobs/:id/sections

- [ ] Returns sections from ALL crawled pages (not just the seed page)
- [ ] Each section still has correct `htmlUrl` and `thumbnailUrl` properties
- [ ] Section ordering makes sense (grouped by page? global order?)

---

## 4. Compatibility / Regression Risks

### 4.1 Existing Features That Could Break

- [ ] **Single-page crawl**: Sites with no internal links must still work identically
- [ ] **Auto-crawler**: The `auto-crawler.ts` flow (submit + poll) must handle multi-page timing
- [ ] **Section cleanup**: `cleanupCrawlRunSections` must work across multiple pages
- [ ] **Site download**: `downloadSite()` is called per sub-page - verify it works with a fresh Page
- [ ] **ZIP export**: Export should include sections from all pages
- [ ] **TSX conversion**: On-demand TSX generation should work for sub-page sections
- [ ] **Dashboard/Library UI**: Sections view should handle sections from multiple pages
- [ ] **Canvas**: Blocks from sub-pages should be usable on the canvas

### 4.2 Performance Concerns

- [ ] Crawl time: 5 pages * ~30s each = ~150s. Does it fit within the 180s SITE_TIMEOUT_MS?
- [ ] Worker poll loop: Long-running multi-page jobs block the worker from other jobs
- [ ] Storage: 5x the assets stored per job. Disk/Supabase storage impact?
- [ ] Rate limiting: 5 rapid requests to the same domain may trigger bot detection
- [ ] Auto-crawler timeout: 3-minute deadline in `submitAndWait` may be too short for 5 pages

---

## 5. Manual Test Plan

### 5.1 Basic Multi-Page Crawl

1. Submit a URL to a multi-page site (e.g., a corporate site with nav links)
2. Verify the job completes with status `done`
3. Check `page_count` is > 1 (up to 5)
4. Verify sections from sub-pages appear in GET /api/jobs/:id/sections
5. Verify each section renders correctly in the UI

### 5.2 Single-Page Fallback

1. Submit a URL to a single-page site (no internal links)
2. Verify it behaves exactly like the current single-page flow
3. Check `page_count` is 1

### 5.3 Auth Page Skipping

1. Submit a URL to a site with login/signup links in navigation
2. Verify the /login and /signup pages are NOT crawled
3. Verify the non-auth pages ARE crawled
4. Check server logs for "skipped auth page" or similar messages

### 5.4 Max Page Limit

1. Submit a URL to a site with 20+ internal links
2. Verify only 5 pages total are crawled (seed + 4 sub-pages)
3. Verify the selection is deterministic (first N links chosen)

### 5.5 Error Recovery

1. Submit a URL where one linked page returns 500
2. Verify the job still completes with sections from other pages
3. Check that the failed page is logged but does not cause job failure

### 5.6 External Link Filtering

1. Submit a URL with many external links (social media, partners, etc.)
2. Verify only same-domain links are followed
3. Verify no external pages are crawled

### 5.7 Redirect Handling

1. Submit a URL where some links redirect to auth pages
2. Verify those redirected pages are detected and skipped
3. Submit a URL where links redirect within the same domain (301/302)
4. Verify the redirected-to page is crawled (not the original URL)

---

## 6. Test File Reference

The automated tests are in:
  `server/__tests__/multi-page-crawl.test.ts`

These tests cover:
- `collectSameDomainLinks` - Link extraction with domain filtering
- `isAuthUrl` - Auth URL pattern detection
- `isAuthStatus` - HTTP status code detection (401/403)
- `isLoginRedirect` - Redirect-to-login detection
- `normalizeUrlForDedup` - URL normalization for deduplication
- `selectPagesToVisit` - Max page limit and dedup enforcement
- Integration: Full pipeline from HTML to selected pages
- Edge cases: Ports, encoded chars, empty HTML, malformed hrefs

### Running the tests

Once the implementation is merged, update the imports in the test file:
```typescript
// Replace inline reference functions with real imports:
import {
  collectSameDomainLinks,
  isAuthUrl,
  isAuthStatus,
  isLoginRedirect,
  normalizeUrlForDedup,
  selectPagesToVisit,
} from '../worker.js'  // or from wherever the helpers are exported
```

Then run:
```bash
npm test
```
