/**
 * CERT.at Ingestion Crawler
 *
 * Scrapes the CERT.at website (cert.at) and populates the SQLite database
 * with real guidance documents, security advisories, and frameworks from
 * Austria's national CSIRT.
 *
 * Data sources:
 *   1. Warnungen (Warnings)   — paginated listing + RSS feed + detail pages
 *   2. Aktuelles (News)       — paginated listing + detail pages
 *   3. Spezielles (Specials)  — paginated listing + detail pages (→ guidance)
 *   4. Blog posts             — paginated listing + detail pages (→ guidance)
 *
 * Content language: German (original)
 *
 * Usage:
 *   npx tsx scripts/ingest-cert-at.ts                   # full crawl
 *   npx tsx scripts/ingest-cert-at.ts --resume          # resume from last checkpoint
 *   npx tsx scripts/ingest-cert-at.ts --dry-run         # log what would be inserted
 *   npx tsx scripts/ingest-cert-at.ts --force           # drop and recreate DB first
 *   npx tsx scripts/ingest-cert-at.ts --advisories-only # only crawl advisories
 *   npx tsx scripts/ingest-cert-at.ts --guidance-only   # only crawl guidance
 */

import Database from "better-sqlite3";
import * as cheerio from "cheerio";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DB_PATH = process.env["CERTAT_DB_PATH"] ?? "data/certat.db";
const PROGRESS_FILE = resolve(dirname(DB_PATH), "ingest-progress.json");
const BASE_URL = "https://www.cert.at";

const WARNINGS_LISTING = `${BASE_URL}/de/meldungen/warnungen/`;
const AKTUELLES_LISTING = `${BASE_URL}/de/meldungen/aktuelles/`;
const SPEZIELLES_LISTING = `${BASE_URL}/de/meldungen/spezielles/`;
const BLOG_LISTING = `${BASE_URL}/de/meldungen/blog/`;

const WARNINGS_RSS = `${BASE_URL}/cert-at.de.warnings.rss_2.0.xml`;
const AKTUELLES_RSS = `${BASE_URL}/cert-at.de.current.rss_2.0.xml`;
const SPECIALS_RSS = `${BASE_URL}/cert-at.de.specials.rss_2.0.xml`;
const BLOG_RSS = `${BASE_URL}/cert-at.de.blog.rss_2.0.xml`;

const RATE_LIMIT_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 2000;
const REQUEST_TIMEOUT_MS = 30_000;
const USER_AGENT =
  "AnsvarCERTatCrawler/1.0 (+https://ansvar.eu; compliance research)";

// CLI flags
const args = process.argv.slice(2);
const force = args.includes("--force");
const dryRun = args.includes("--dry-run");
const resume = args.includes("--resume");
const advisoriesOnly = args.includes("--advisories-only");
const guidanceOnly = args.includes("--guidance-only");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GuidanceRow {
  reference: string;
  title: string;
  title_en: string | null;
  date: string | null;
  type: string;
  series: string;
  summary: string;
  full_text: string;
  topics: string;
  status: string;
}

interface AdvisoryRow {
  reference: string;
  title: string;
  date: string | null;
  severity: string | null;
  affected_products: string | null;
  summary: string;
  full_text: string;
  cve_references: string | null;
}

interface FrameworkRow {
  id: string;
  name: string;
  name_en: string | null;
  description: string;
  document_count: number;
}

interface Progress {
  completed_warning_urls: string[];
  completed_aktuelles_urls: string[];
  completed_specials_urls: string[];
  completed_blog_urls: string[];
  last_updated: string;
}

interface RssItem {
  title: string;
  link: string;
  description: string;
  pubDate: string;
  guid: string;
}

// ---------------------------------------------------------------------------
// Counters
// ---------------------------------------------------------------------------

const counters = {
  advisories_inserted: 0,
  advisories_skipped: 0,
  guidance_inserted: 0,
  guidance_skipped: 0,
  pages_fetched: 0,
  errors: 0,
};

// ---------------------------------------------------------------------------
// Utility: rate-limited fetch with retry
// ---------------------------------------------------------------------------

let lastRequestTime = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function rateLimitedFetch(
  url: string,
  opts?: RequestInit,
): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      lastRequestTime = Date.now();
      const resp = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept:
            "text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...opts,
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} for ${url}`);
      }
      return resp;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `  [retry ${attempt}/${MAX_RETRIES}] ${url}: ${lastError.message}`,
      );
      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BACKOFF_MS * attempt);
      }
    }
  }
  throw lastError!;
}

async function fetchText(url: string): Promise<string> {
  const resp = await rateLimitedFetch(url);
  counters.pages_fetched++;
  return resp.text();
}

// ---------------------------------------------------------------------------
// RSS parser
// ---------------------------------------------------------------------------

function parseRssItems(xml: string): RssItem[] {
  const items: RssItem[] = [];
  const $ = cheerio.load(xml, { xmlMode: true });

  $("item").each((_i, el) => {
    const $el = $(el);
    items.push({
      title: $el.find("title").first().text().trim(),
      link: $el.find("link").first().text().trim(),
      description: $el.find("description").first().text().trim(),
      pubDate: $el.find("pubDate").first().text().trim(),
      guid: $el.find("guid").first().text().trim(),
    });
  });

  return items;
}

// ---------------------------------------------------------------------------
// HTML parsing helpers
// ---------------------------------------------------------------------------

/**
 * German month names to numeric month (01–12).
 */
const DE_MONTHS: Record<string, string> = {
  januar: "01",
  jänner: "01",
  februar: "02",
  "märz": "03",
  marz: "03",
  april: "04",
  mai: "05",
  juni: "06",
  juli: "07",
  august: "08",
  september: "09",
  oktober: "10",
  november: "11",
  dezember: "12",
  // Abbreviated
  jan: "01",
  feb: "02",
  "mär": "03",
  mar: "03",
  apr: "04",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  okt: "10",
  nov: "11",
  dez: "12",
};

/**
 * Parse a German date string into ISO format (YYYY-MM-DD).
 * Handles formats like "05. März 2026", "12.06.2025", "13.03.2026 14:17".
 */
function parseGermanDate(dateStr: string): string | null {
  if (!dateStr) return null;
  const s = dateStr.trim();

  // "12.06.2025" or "13.03.2026 14:17"
  const numericMatch = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (numericMatch) {
    const day = numericMatch[1]!.padStart(2, "0");
    const month = numericMatch[2]!.padStart(2, "0");
    const year = numericMatch[3]!;
    return `${year}-${month}-${day}`;
  }

  // "05. März 2026" or "20. März 2025"
  const longMatch = s.match(/^(\d{1,2})\.\s*(\w+)\s+(\d{4})/);
  if (longMatch) {
    const day = longMatch[1]!.padStart(2, "0");
    const monthName = longMatch[2]!.toLowerCase();
    const year = longMatch[3]!;
    const month = DE_MONTHS[monthName];
    if (month) {
      return `${year}-${month}-${day}`;
    }
  }

  // Try RFC 2822: "Thu, 05 Mar 2026 11:03:43 GMT+0100"
  try {
    const d = new Date(s);
    if (!isNaN(d.getTime())) {
      return d.toISOString().slice(0, 10);
    }
  } catch {
    // Ignore
  }

  return null;
}

/**
 * Extract CVE references from text. Returns comma-separated string or null.
 */
function extractCves(text: string): string | null {
  const cves = new Set<string>();
  const re = /CVE-\d{4}-\d{4,}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    cves.add(m[0]);
  }
  return cves.size > 0 ? Array.from(cves).sort().join(", ") : null;
}

/**
 * Infer severity from page text by looking for CVSS scores and keywords.
 * Returns: "critical", "high", "medium", "low", or null.
 */
function inferSeverity(text: string): string | null {
  // Check for explicit CVSS score
  const cvssMatch = text.match(
    /CVSS(?:\s+(?:Base\s+)?Score)?[:\s]+(?:bis\s+zu\s+)?(\d+(?:\.\d+)?)/i,
  );
  if (cvssMatch) {
    const score = parseFloat(cvssMatch[1]!);
    if (score >= 9.0) return "critical";
    if (score >= 7.0) return "high";
    if (score >= 4.0) return "medium";
    return "low";
  }

  // Check for German severity keywords
  const lower = text.toLowerCase();
  if (
    lower.includes("kritisch") ||
    lower.includes("kritische sicherheitslücke") ||
    lower.includes("remote code execution")
  ) {
    return "critical";
  }
  if (
    lower.includes("hoch") ||
    lower.includes("schwerwiegend") ||
    lower.includes("dringend")
  ) {
    return "high";
  }
  if (lower.includes("mittel") || lower.includes("moderate")) {
    return "medium";
  }

  return null;
}

/**
 * Extract topics from a warning/guidance page as JSON array string.
 */
function extractTopics(title: string, text: string): string {
  const topics: string[] = [];
  const lower = (title + " " + text).toLowerCase();

  const topicMap: Record<string, string> = {
    ransomware: "Ransomware",
    phishing: "Phishing",
    vpn: "VPN",
    firewall: "Firewall",
    "remote code execution": "RCE",
    rce: "RCE",
    "denial of service": "DoS",
    "sql injection": "SQL Injection",
    kryptograph: "Kryptographie",
    verschlüsselung: "Verschlüsselung",
    authentifizierung: "Authentifizierung",
    "nis2": "NIS2",
    "nis-richtlinie": "NIS",
    "kritische infrastruktur": "Kritische Infrastruktur",
    "supply chain": "Supply Chain",
    lieferkette: "Lieferkette",
    "active directory": "Active Directory",
    exchange: "Exchange",
    "zero-day": "Zero-Day",
    "0-day": "Zero-Day",
    scada: "SCADA",
    ics: "ICS",
    iot: "IoT",
    "patch management": "Patch-Management",
    backup: "Backup",
    meldepflicht: "Meldepflicht",
    "incident response": "Incident Response",
    malware: "Malware",
    schwachstelle: "Schwachstelle",
    sicherheitslücke: "Schwachstelle",
    cisco: "Cisco",
    microsoft: "Microsoft",
    fortinet: "Fortinet",
    ivanti: "Ivanti",
    oracle: "Oracle",
    apache: "Apache",
    linux: "Linux",
    windows: "Windows",
    android: "Android",
    apple: "Apple",
    sap: "SAP",
    vmware: "VMware",
  };

  for (const [keyword, topic] of Object.entries(topicMap)) {
    if (lower.includes(keyword) && !topics.includes(topic)) {
      topics.push(topic);
    }
  }

  // Cap at 8 topics
  return JSON.stringify(topics.slice(0, 8));
}

/**
 * Build a reference ID from a CERT.at URL.
 * e.g. /de/warnungen/2026/3/slug -> CERT.at-W-2026-03-slug
 * e.g. /de/aktuelles/2026/3/slug -> CERT.at-N-2026-03-slug
 * e.g. /de/spezielles/2022/2/slug -> CERT.at-S-2022-02-slug
 * e.g. /de/blog/2024/5/slug -> CERT.at-B-2024-05-slug
 */
function buildReference(url: string, type: "W" | "N" | "S" | "B"): string {
  const path = url.replace(BASE_URL, "").replace(/^\/+/, "");
  // Path: de/warnungen/2026/3/slug or de/aktuelles/2026/3/slug
  const parts = path.split("/");
  // Find year/month/slug portions
  const yearIdx = parts.findIndex((p) => /^\d{4}$/.test(p));
  if (yearIdx >= 0 && yearIdx + 2 < parts.length) {
    const year = parts[yearIdx]!;
    const month = parts[yearIdx + 1]!.padStart(2, "0");
    const slug = parts
      .slice(yearIdx + 2)
      .join("-")
      .slice(0, 60);
    return `CERT.at-${type}-${year}-${month}-${slug}`;
  }
  // Fallback: hash-like reference
  const slug = parts.slice(-1)[0] ?? "unknown";
  return `CERT.at-${type}-${slug}`.slice(0, 80);
}

// ---------------------------------------------------------------------------
// Detail page scraper
// ---------------------------------------------------------------------------

interface DetailPage {
  title: string;
  date: string | null;
  sections: Record<string, string>;
  fullText: string;
  sourceLinks: string[];
}

/**
 * Scrape a single CERT.at detail page (warning, aktuelles, spezielles, blog).
 * Extracts title, date, sections, and full text body.
 */
async function scrapeDetailPage(url: string): Promise<DetailPage> {
  const html = await fetchText(url);
  const $ = cheerio.load(html);

  // Title: first h1 in main content, or the page title
  const title =
    $("article h1, .content h1, main h1, h1").first().text().trim() ||
    $("title").text().replace(/ - CERT\.at.*$/, "").trim();

  // Date: look for the date string in the content area.
  // CERT.at typically places the date as a <p class="block"> or just text near the top.
  let dateStr: string | null = null;

  // Strategy 1: look for <p class="block"> containing a date
  $('p.block, p.date, .date, time, span.date, em').each((_i, el) => {
    const text = $(el).text().trim();
    const parsed = parseGermanDate(text);
    if (parsed && !dateStr) {
      dateStr = parsed;
    }
  });

  // Strategy 2: scan the first few paragraphs for a date pattern
  if (!dateStr) {
    $("article p, .content p, main p")
      .slice(0, 5)
      .each((_i, el) => {
        const text = $(el).text().trim();
        // Match "05. März 2026" or "13.03.2026 14:17"
        const dateMatch = text.match(
          /\d{1,2}\.\s*(?:\w+\s+\d{4}|\d{1,2}\.\d{4})/,
        );
        if (dateMatch && !dateStr) {
          dateStr = parseGermanDate(dateMatch[0]);
        }
      });
  }

  // Extract sections by h2 headings
  const sections: Record<string, string> = {};
  const contentArea = $("article, main, .content").first();
  const h2Elements = contentArea.find("h2");

  if (h2Elements.length > 0) {
    h2Elements.each((_i, el) => {
      const heading = $(el).text().trim();
      // Collect all sibling content until next h2
      let sectionContent = "";
      let next = $(el).next();
      while (next.length > 0 && !next.is("h2")) {
        sectionContent += next.text().trim() + "\n";
        next = next.next();
      }
      sections[heading] = sectionContent.trim();
    });
  }

  // Full text: all text from the content area
  const fullText = contentArea.text().replace(/\s+/g, " ").trim();

  // Source links from "Informationsquelle(n)" section
  const sourceLinks: string[] = [];
  contentArea.find('a[href^="http"]').each((_i, el) => {
    const href = $(el).attr("href");
    if (
      href &&
      !href.includes("cert.at/de/meldungen") &&
      !href.includes("cert.at/de/services")
    ) {
      sourceLinks.push(href);
    }
  });

  return { title, date: dateStr, sections, fullText, sourceLinks };
}

// ---------------------------------------------------------------------------
// Listing page scraper
// ---------------------------------------------------------------------------

interface ListingEntry {
  url: string;
  title: string;
  dateBrief: string;
  summary: string;
}

/**
 * Scrape a CERT.at listing page (warnungen, aktuelles, spezielles, blog).
 * Returns entries and the URL of the next page (or null).
 */
async function scrapeListingPage(
  pageUrl: string,
): Promise<{ entries: ListingEntry[]; nextPageUrl: string | null }> {
  const html = await fetchText(pageUrl);
  const $ = cheerio.load(html);
  const entries: ListingEntry[] = [];

  // CERT.at listing pages show entries with a date, a title link, a summary,
  // and a "Weiterlesen" link. Each entry is typically inside a block-level
  // container. The structure uses semantic elements or div wrappers.
  //
  // We look for links pointing to detail pages (matching known URL patterns).
  const detailLinkPattern =
    /\/de\/(?:warnungen|aktuelles|spezielles|blog)\/\d{4}\/\d{1,2}\//;

  // Collect unique detail URLs and their associated text
  const seen = new Set<string>();

  // Strategy: find all links that point to detail pages
  $("a[href]").each((_i, el) => {
    const href = $(el).attr("href") ?? "";
    const fullHref = href.startsWith("http")
      ? href
      : `${BASE_URL}${href.startsWith("/") ? "" : "/"}${href}`;

    if (
      detailLinkPattern.test(fullHref) &&
      !seen.has(fullHref) &&
      // Exclude "Weiterlesen" links (duplicate of same entry)
      $(el).text().trim() !== "Weiterlesen"
    ) {
      seen.add(fullHref);
      const title = $(el).text().trim();
      if (title.length > 5) {
        // Look for date and summary near this link
        const parent = $(el).closest("div, article, section, li");
        const parentText = parent.text().trim();
        const dateMatch = parentText.match(
          /(\d{1,2}\.\s*\w+\s+\d{4}|\d{1,2}\.\d{1,2}\.\d{4})/,
        );

        entries.push({
          url: fullHref,
          title,
          dateBrief: dateMatch ? dateMatch[1]! : "",
          summary: parentText.slice(0, 300),
        });
      }
    }
  });

  // Also collect "Weiterlesen" links that might have been missed
  $('a[href]')
    .filter((_i, el) => $(el).text().trim() === "Weiterlesen")
    .each((_i, el) => {
      const href = $(el).attr("href") ?? "";
      const fullHref = href.startsWith("http")
        ? href
        : `${BASE_URL}${href.startsWith("/") ? "" : "/"}${href}`;
      if (detailLinkPattern.test(fullHref) && !seen.has(fullHref)) {
        seen.add(fullHref);
        entries.push({
          url: fullHref,
          title: "",
          dateBrief: "",
          summary: "",
        });
      }
    });

  // Find next page link in pagination
  let nextPageUrl: string | null = null;
  // Pagination uses numbered links, with "›" or "»" for next
  $("a").each((_i, el) => {
    const text = $(el).text().trim();
    if (text === "\u203A" || text === "›" || text === "\u00BB" || text === "»") {
      const href = $(el).attr("href");
      if (href) {
        nextPageUrl = href.startsWith("http")
          ? href
          : `${BASE_URL}${href.startsWith("/") ? "" : "/"}${href}`;
      }
    }
  });

  // Alternative: find the page number that is current+1
  if (!nextPageUrl) {
    const currentPageMatch = pageUrl.match(/\/(\d+)\/?$/);
    const currentPage = currentPageMatch ? parseInt(currentPageMatch[1]!, 10) : 1;
    const nextPage = currentPage + 1;

    $("a[href]").each((_i, el) => {
      const href = $(el).attr("href") ?? "";
      const text = $(el).text().trim();
      if (text === String(nextPage)) {
        nextPageUrl = href.startsWith("http")
          ? href
          : `${BASE_URL}${href.startsWith("/") ? "" : "/"}${href}`;
      }
    });
  }

  return { entries, nextPageUrl };
}

/**
 * Crawl all pages of a listing, collecting all entry URLs.
 */
async function crawlAllListingPages(
  startUrl: string,
  label: string,
): Promise<ListingEntry[]> {
  const allEntries: ListingEntry[] = [];
  let currentUrl: string | null = startUrl;
  let pageNum = 1;

  while (currentUrl) {
    console.log(`  [${label}] Fetching page ${pageNum}: ${currentUrl}`);
    try {
      const { entries, nextPageUrl } = await scrapeListingPage(currentUrl);
      allEntries.push(...entries);
      console.log(
        `  [${label}] Page ${pageNum}: ${entries.length} entries found`,
      );
      currentUrl = nextPageUrl;
      pageNum++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [${label}] Error on page ${pageNum}: ${msg}`);
      counters.errors++;
      break;
    }
  }

  // Deduplicate by URL
  const seen = new Set<string>();
  const unique = allEntries.filter((e) => {
    if (seen.has(e.url)) return false;
    seen.add(e.url);
    return true;
  });

  console.log(
    `  [${label}] Total: ${unique.length} unique entries across ${pageNum - 1} pages`,
  );
  return unique;
}

// ---------------------------------------------------------------------------
// Also collect URLs from RSS feeds (catches items that listing may miss)
// ---------------------------------------------------------------------------

async function collectRssUrls(
  feedUrl: string,
  label: string,
): Promise<ListingEntry[]> {
  console.log(`  [${label}] Fetching RSS feed: ${feedUrl}`);
  try {
    const xml = await fetchText(feedUrl);
    const items = parseRssItems(xml);
    console.log(`  [${label}] RSS feed: ${items.length} items`);
    return items.map((item) => ({
      url: item.link,
      title: item.title,
      dateBrief: item.pubDate,
      summary: "",
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  [${label}] RSS feed error: ${msg}`);
    counters.errors++;
    return [];
  }
}

// ---------------------------------------------------------------------------
// Advisory processing (Warnungen → advisories table)
// ---------------------------------------------------------------------------

async function processWarning(
  db: Database.Database,
  url: string,
  progress: Progress,
): Promise<void> {
  if (progress.completed_warning_urls.includes(url)) {
    counters.advisories_skipped++;
    return;
  }

  const reference = buildReference(url, "W");

  // Check if already in DB
  const existing = db
    .prepare("SELECT 1 FROM advisories WHERE reference = ?")
    .get(reference);
  if (existing) {
    counters.advisories_skipped++;
    progress.completed_warning_urls.push(url);
    return;
  }

  console.log(`    Scraping warning: ${url}`);
  let detail: DetailPage;
  try {
    detail = await scrapeDetailPage(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`    Error scraping ${url}: ${msg}`);
    counters.errors++;
    return;
  }

  if (!detail.fullText || detail.fullText.length < 50) {
    console.warn(`    Skipping ${url}: insufficient content`);
    counters.errors++;
    return;
  }

  const title = detail.title || reference;
  const date = detail.date;
  const severity = inferSeverity(detail.fullText);
  const cveRefs = extractCves(detail.fullText);

  // Extract affected products from "Betroffene Systeme" section
  const affectedProducts =
    detail.sections["Betroffene Systeme"] ??
    detail.sections["Betroffene Software"] ??
    null;

  // Build summary from "Beschreibung" section or first 500 chars
  const summary =
    detail.sections["Beschreibung"]?.slice(0, 600) ??
    detail.fullText.slice(0, 600);

  const row: AdvisoryRow = {
    reference,
    title,
    date,
    severity,
    affected_products: affectedProducts
      ? affectedProducts.slice(0, 2000)
      : null,
    summary: summary.trim(),
    full_text: detail.fullText,
    cve_references: cveRefs,
  };

  if (dryRun) {
    console.log(
      `    [dry-run] Would insert advisory: ${reference} | ${title.slice(0, 70)} | severity=${severity} | CVEs=${cveRefs ?? "none"}`,
    );
  } else {
    db.prepare(
      `INSERT OR IGNORE INTO advisories (reference, title, date, severity, affected_products, summary, full_text, cve_references)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.reference,
      row.title,
      row.date,
      row.severity,
      row.affected_products,
      row.summary,
      row.full_text,
      row.cve_references,
    );
  }

  counters.advisories_inserted++;
  progress.completed_warning_urls.push(url);
}

// ---------------------------------------------------------------------------
// Guidance processing (Aktuelles, Spezielles, Blog → guidance table)
// ---------------------------------------------------------------------------

/**
 * Map section type string to the content category.
 */
function contentType(
  section: "aktuelles" | "spezielles" | "blog",
): { type: string; series: string } {
  switch (section) {
    case "aktuelles":
      return { type: "security_news", series: "CERT.at-Aktuelles" };
    case "spezielles":
      return { type: "special_report", series: "CERT.at-Spezielles" };
    case "blog":
      return { type: "blog_post", series: "CERT.at-Blog" };
  }
}

async function processGuidanceEntry(
  db: Database.Database,
  url: string,
  section: "aktuelles" | "spezielles" | "blog",
  refType: "N" | "S" | "B",
  completedList: string[],
): Promise<void> {
  if (completedList.includes(url)) {
    counters.guidance_skipped++;
    return;
  }

  const reference = buildReference(url, refType);

  // Check if already in DB
  const existing = db
    .prepare("SELECT 1 FROM guidance WHERE reference = ?")
    .get(reference);
  if (existing) {
    counters.guidance_skipped++;
    completedList.push(url);
    return;
  }

  console.log(`    Scraping ${section}: ${url}`);
  let detail: DetailPage;
  try {
    detail = await scrapeDetailPage(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`    Error scraping ${url}: ${msg}`);
    counters.errors++;
    return;
  }

  if (!detail.fullText || detail.fullText.length < 50) {
    console.warn(`    Skipping ${url}: insufficient content`);
    counters.errors++;
    return;
  }

  const { type, series } = contentType(section);
  const title = detail.title || reference;
  const topics = extractTopics(title, detail.fullText);

  // Summary: first meaningful section or first 500 chars
  const summary =
    detail.sections["Beschreibung"]?.slice(0, 600) ??
    detail.fullText.slice(0, 600);

  const row: GuidanceRow = {
    reference,
    title,
    title_en: null,
    date: detail.date,
    type,
    series,
    summary: summary.trim(),
    full_text: detail.fullText,
    topics,
    status: "current",
  };

  if (dryRun) {
    console.log(
      `    [dry-run] Would insert guidance: ${reference} | ${title.slice(0, 70)} | type=${type}`,
    );
  } else {
    db.prepare(
      `INSERT OR IGNORE INTO guidance (reference, title, title_en, date, type, series, summary, full_text, topics, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      row.reference,
      row.title,
      row.title_en,
      row.date,
      row.type,
      row.series,
      row.summary,
      row.full_text,
      row.topics,
      row.status,
    );
  }

  counters.guidance_inserted++;
  completedList.push(url);
}

// ---------------------------------------------------------------------------
// Progress tracking
// ---------------------------------------------------------------------------

function loadProgress(): Progress {
  if (resume && existsSync(PROGRESS_FILE)) {
    try {
      const raw = readFileSync(PROGRESS_FILE, "utf-8");
      const p = JSON.parse(raw) as Progress;
      console.log(
        `Resuming from checkpoint (${p.last_updated}): ` +
          `${p.completed_warning_urls.length} warnings, ` +
          `${p.completed_aktuelles_urls.length} aktuelles, ` +
          `${p.completed_specials_urls.length} specials, ` +
          `${p.completed_blog_urls.length} blog posts`,
      );
      return p;
    } catch {
      console.warn("Could not parse progress file, starting fresh");
    }
  }
  return {
    completed_warning_urls: [],
    completed_aktuelles_urls: [],
    completed_specials_urls: [],
    completed_blog_urls: [],
    last_updated: new Date().toISOString(),
  };
}

function saveProgress(progress: Progress): void {
  progress.last_updated = new Date().toISOString();
  writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// ---------------------------------------------------------------------------
// Database setup
// ---------------------------------------------------------------------------

function initDatabase(): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  if (force && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`Deleted existing database at ${DB_PATH}`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  console.log(`Database initialised at ${DB_PATH}`);
  return db;
}

// ---------------------------------------------------------------------------
// Framework definitions (static)
// ---------------------------------------------------------------------------

const FRAMEWORKS: FrameworkRow[] = [
  {
    id: "cert-at",
    name: "CERT.at Warnungen und Empfehlungen",
    name_en: "CERT.at Warnings and Recommendations",
    description:
      "CERT.at (Austrian Computer Emergency Response Team) veröffentlicht " +
      "Warnungen zu aktuellen Cyberbedrohungen, technische Empfehlungen und " +
      "Handlungsanleitungen. Zuständig für die koordinierte Reaktion auf " +
      "Cybersicherheitsvorfälle in Österreich. Nationaler CSIRT gemäß NIS-Richtlinie.",
    document_count: 0, // Updated after crawl
  },
  {
    id: "itsg",
    name: "IT-Sicherheitshandbuch (ITSG)",
    name_en: "Austrian IT Security Handbook",
    description:
      "Das IT-Sicherheitshandbuch (ITSG) des Bundeskanzleramts definiert " +
      "Anforderungen für den sicheren Einsatz von IKT in der österreichischen " +
      "Bundesverwaltung. Es umfasst Mindeststandards, Sicherheitsmaßnahmen " +
      "und Implementierungsleitfäden. Grundlage für die NIS-Richtlinienumsetzung " +
      "in Österreich.",
    document_count: 0,
  },
  {
    id: "mindeststandard",
    name: "IKT-Mindeststandard",
    name_en: "ICT Minimum Standard",
    description:
      "Der IKT-Mindeststandard des Bundeskanzleramts legt verbindliche " +
      "Mindestsicherheitsanforderungen für IKT-Systeme der Bundesverwaltung " +
      "fest. Basiert auf dem NIST Cybersecurity Framework und dem ISO 27001 " +
      "Standard. Enthält Maßnahmen zu Identifizieren, Schützen, Erkennen, " +
      "Reagieren und Wiederherstellen.",
    document_count: 0,
  },
  {
    id: "nis-behoerde",
    name: "NIS-Behörde (RTR)",
    name_en: "NIS Authority (RTR)",
    description:
      "Die RTR-GmbH (Rundfunk und Telekom Regulierungs-GmbH) ist die " +
      "zuständige NIS-Behörde in Österreich. Verantwortlich für die " +
      "Umsetzung der NIS- und NIS2-Richtlinie, Meldepflichten für " +
      "wesentliche und wichtige Einrichtungen, und die Aufsicht über " +
      "Cybersicherheitsmaßnahmen in kritischer Infrastruktur.",
    document_count: 0,
  },
];

function insertFrameworks(db: Database.Database): void {
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO frameworks (id, name, name_en, description, document_count) VALUES (?, ?, ?, ?, ?)",
  );
  for (const f of FRAMEWORKS) {
    stmt.run(f.id, f.name, f.name_en, f.description, f.document_count);
  }
  console.log(`Inserted ${FRAMEWORKS.length} frameworks`);
}

function updateFrameworkCounts(db: Database.Database): void {
  const advisoryCount = (
    db.prepare("SELECT COUNT(*) as n FROM advisories").get() as { n: number }
  ).n;
  const guidanceCount = (
    db.prepare("SELECT COUNT(*) as n FROM guidance").get() as { n: number }
  ).n;

  db.prepare("UPDATE frameworks SET document_count = ? WHERE id = ?").run(
    advisoryCount,
    "cert-at",
  );
  // Distribute guidance count across guidance-related frameworks
  db.prepare("UPDATE frameworks SET document_count = ? WHERE id = ?").run(
    guidanceCount,
    "itsg",
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("=== CERT.at Ingestion Crawler ===");
  console.log(`Database: ${DB_PATH}`);
  console.log(
    `Flags: force=${force} dry-run=${dryRun} resume=${resume} ` +
      `advisories-only=${advisoriesOnly} guidance-only=${guidanceOnly}`,
  );
  console.log();

  const db = initDatabase();
  const progress = loadProgress();

  // Insert framework definitions
  if (!dryRun) {
    insertFrameworks(db);
  }

  // ------------------------------------------------------------------
  // Phase 1: Crawl Warnungen (Warnings) → advisories table
  // ------------------------------------------------------------------
  if (!guidanceOnly) {
    console.log("\n--- Phase 1: Warnungen (Warnings) → advisories ---");

    // Collect URLs from both listing pages and RSS feed
    const listingEntries = await crawlAllListingPages(
      WARNINGS_LISTING,
      "Warnungen-Listing",
    );
    const rssEntries = await collectRssUrls(WARNINGS_RSS, "Warnungen-RSS");

    // Merge and deduplicate
    const allUrls = new Set<string>();
    for (const e of [...listingEntries, ...rssEntries]) {
      allUrls.add(e.url);
    }

    console.log(
      `\n  Total unique warning URLs: ${allUrls.size} (${listingEntries.length} from listing, ${rssEntries.length} from RSS)`,
    );

    let idx = 0;
    for (const url of allUrls) {
      idx++;
      if (idx % 10 === 0 || idx === 1) {
        console.log(
          `  Progress: ${idx}/${allUrls.size} warnings (${counters.advisories_inserted} inserted, ${counters.advisories_skipped} skipped)`,
        );
      }
      await processWarning(db, url, progress);

      // Save progress every 25 items
      if (idx % 25 === 0 && !dryRun) {
        saveProgress(progress);
      }
    }

    if (!dryRun) saveProgress(progress);
    console.log(
      `\n  Warnings complete: ${counters.advisories_inserted} inserted, ${counters.advisories_skipped} skipped`,
    );
  }

  // ------------------------------------------------------------------
  // Phase 2: Crawl Aktuelles (News) → guidance table
  // ------------------------------------------------------------------
  if (!advisoriesOnly) {
    console.log("\n--- Phase 2: Aktuelles (News) → guidance ---");

    const listingEntries = await crawlAllListingPages(
      AKTUELLES_LISTING,
      "Aktuelles-Listing",
    );
    const rssEntries = await collectRssUrls(AKTUELLES_RSS, "Aktuelles-RSS");

    const allUrls = new Set<string>();
    for (const e of [...listingEntries, ...rssEntries]) {
      allUrls.add(e.url);
    }

    console.log(
      `\n  Total unique Aktuelles URLs: ${allUrls.size}`,
    );

    let idx = 0;
    for (const url of allUrls) {
      idx++;
      if (idx % 10 === 0 || idx === 1) {
        console.log(
          `  Progress: ${idx}/${allUrls.size} aktuelles (${counters.guidance_inserted} inserted)`,
        );
      }
      await processGuidanceEntry(
        db,
        url,
        "aktuelles",
        "N",
        progress.completed_aktuelles_urls,
      );

      if (idx % 25 === 0 && !dryRun) {
        saveProgress(progress);
      }
    }

    if (!dryRun) saveProgress(progress);
  }

  // ------------------------------------------------------------------
  // Phase 3: Crawl Spezielles (Special Reports) → guidance table
  // ------------------------------------------------------------------
  if (!advisoriesOnly) {
    console.log("\n--- Phase 3: Spezielles (Special Reports) → guidance ---");

    const listingEntries = await crawlAllListingPages(
      SPEZIELLES_LISTING,
      "Spezielles-Listing",
    );
    const rssEntries = await collectRssUrls(SPECIALS_RSS, "Spezielles-RSS");

    const allUrls = new Set<string>();
    for (const e of [...listingEntries, ...rssEntries]) {
      allUrls.add(e.url);
    }

    console.log(`\n  Total unique Spezielles URLs: ${allUrls.size}`);

    let idx = 0;
    for (const url of allUrls) {
      idx++;
      console.log(
        `  Progress: ${idx}/${allUrls.size} spezielles (${counters.guidance_inserted} inserted)`,
      );
      await processGuidanceEntry(
        db,
        url,
        "spezielles",
        "S",
        progress.completed_specials_urls,
      );

      if (idx % 25 === 0 && !dryRun) {
        saveProgress(progress);
      }
    }

    if (!dryRun) saveProgress(progress);
  }

  // ------------------------------------------------------------------
  // Phase 4: Crawl Blog → guidance table
  // ------------------------------------------------------------------
  if (!advisoriesOnly) {
    console.log("\n--- Phase 4: Blog → guidance ---");

    const listingEntries = await crawlAllListingPages(
      BLOG_LISTING,
      "Blog-Listing",
    );
    const rssEntries = await collectRssUrls(BLOG_RSS, "Blog-RSS");

    const allUrls = new Set<string>();
    for (const e of [...listingEntries, ...rssEntries]) {
      allUrls.add(e.url);
    }

    console.log(`\n  Total unique Blog URLs: ${allUrls.size}`);

    let idx = 0;
    for (const url of allUrls) {
      idx++;
      console.log(
        `  Progress: ${idx}/${allUrls.size} blog (${counters.guidance_inserted} inserted)`,
      );
      await processGuidanceEntry(
        db,
        url,
        "blog",
        "B",
        progress.completed_blog_urls,
      );

      if (idx % 25 === 0 && !dryRun) {
        saveProgress(progress);
      }
    }

    if (!dryRun) saveProgress(progress);
  }

  // ------------------------------------------------------------------
  // Final: update framework document counts and report
  // ------------------------------------------------------------------
  if (!dryRun) {
    updateFrameworkCounts(db);
    saveProgress(progress);
  }

  db.close();

  console.log("\n=== Ingestion Complete ===");
  console.log(`  Pages fetched:       ${counters.pages_fetched}`);
  console.log(`  Advisories inserted: ${counters.advisories_inserted}`);
  console.log(`  Advisories skipped:  ${counters.advisories_skipped}`);
  console.log(`  Guidance inserted:   ${counters.guidance_inserted}`);
  console.log(`  Guidance skipped:    ${counters.guidance_skipped}`);
  console.log(`  Errors:              ${counters.errors}`);
  if (dryRun) {
    console.log("\n  (dry-run mode — no data was written)");
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
