#!/usr/bin/env tsx
/**
 * CERT.at RSS-based ingestion crawler.
 *
 * Replacement for the HTML-page-scraping approach in
 * scripts/ingest-cert-at.ts, which broke when cert.at restructured to a
 * Bootstrap layout (no <article>/<main> tags). RSS feeds remain stable
 * and embed full content in <description>.
 *
 * Trade-off: RSS only exposes the ~50 most recent items per feed, so
 * this won't recover historical archives older than that window. For
 * deep historical coverage, a headless-browser approach is needed
 * (separate work).
 *
 * Feeds (verified 2026-05-16):
 *   - /cert-at.de.warnings.rss_2.0.xml   -> advisories (50 items)
 *   - /cert-at.de.blog.rss_2.0.xml       -> guidance/blog (49 items)
 *   - /cert-at.de.specials.rss_2.0.xml   -> guidance/special (12 items)
 *
 * Usage:
 *   npx tsx scripts/ingest-cert-at-rss.ts          # full feed pull
 *   npx tsx scripts/ingest-cert-at-rss.ts --force  # drop and recreate DB first
 *   npx tsx scripts/ingest-cert-at-rss.ts --dry-run
 */

import Database from "better-sqlite3";
import * as cheerio from "cheerio";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["CERTAT_DB_PATH"] ?? "data/certat.db";
const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64; rv:135.0) Gecko/20100101 Firefox/135.0";
const FETCH_TIMEOUT_MS = 30_000;

const args = process.argv.slice(2);
const force = args.includes("--force");
const dryRun = args.includes("--dry-run");

interface FeedConfig {
  url: string;
  table: "advisory" | "guidance";
  category: string;
  series: string;
}

const FEEDS: FeedConfig[] = [
  {
    url: "https://www.cert.at/cert-at.de.warnings.rss_2.0.xml",
    table: "advisory",
    category: "warning",
    series: "CERT-AT-Warnung",
  },
  {
    url: "https://www.cert.at/cert-at.de.blog.rss_2.0.xml",
    table: "guidance",
    category: "blog",
    series: "CERT-AT-Blog",
  },
  {
    url: "https://www.cert.at/cert-at.de.specials.rss_2.0.xml",
    table: "guidance",
    category: "special",
    series: "CERT-AT-Spezielles",
  },
];

interface RssItem {
  title: string;
  link: string;
  description: string;
  pubDate: string;
  guid: string;
}

async function fetchRss(url: string): Promise<string> {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/rss+xml, application/xml, text/xml;q=0.9",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} for ${url}`);
  }
  return resp.text();
}

function parseRss(xml: string): RssItem[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const items: RssItem[] = [];
  $("item").each((_, el) => {
    const $el = $(el);
    items.push({
      title: $el.find("title").first().text().trim(),
      link: $el.find("link").first().text().trim(),
      description: $el.find("description").first().text().trim(),
      pubDate: $el.find("pubDate").first().text().trim(),
      guid:
        $el.find("guid").first().text().trim() ||
        $el.find("link").first().text().trim(),
    });
  });
  return items;
}

function htmlToText(html: string): string {
  const $ = cheerio.load(`<root>${html}</root>`);
  return $("root").text().replace(/\s+/g, " ").trim();
}

function extractReference(link: string, fallback: string): string {
  const m = link.match(
    /\/(?:warnungen|warnings|blog|specials|spezielles)\/(.+?)\/?$/,
  );
  return m ? m[1]!.replace(/\//g, "-") : fallback;
}

function parsePubDate(rawDate: string): string | null {
  if (!rawDate) return null;
  const d = new Date(rawDate);
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

async function main(): Promise<void> {
  console.log("CERT.at RSS ingestion");
  console.log(`DB: ${DB_PATH}`);
  console.log(`Mode: ${dryRun ? "DRY RUN" : "WRITE"}`);

  if (!dryRun) {
    const dir = dirname(DB_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (force && existsSync(DB_PATH)) {
      unlinkSync(DB_PATH);
      console.log("Existing DB deleted (--force)");
    } else if (existsSync(DB_PATH)) {
      unlinkSync(DB_PATH);
      console.log("Existing DB replaced for fresh load");
    }
  }

  const db = dryRun ? null : new Database(DB_PATH);
  if (db) {
    db.pragma("journal_mode = DELETE");
    db.pragma("foreign_keys = ON");
    db.exec(SCHEMA_SQL);

    db.prepare(
      `INSERT INTO frameworks (id, name, name_en, description) VALUES (?, ?, ?, ?)`,
    ).run(
      "CERT-AT",
      "CERT.at",
      "Austrian National CERT",
      "Computer Emergency Response Team Austria - national CSIRT operated by nic.at on behalf of GovCERT Austria.",
    );
  }

  const insertGuidance = db?.prepare(`
    INSERT INTO guidance (reference, title, title_en, date, type, series, summary, full_text, topics, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertAdvisory = db?.prepare(`
    INSERT INTO advisories (reference, title, date, severity, affected_products, summary, full_text, cve_references)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let totalGuidance = 0;
  let totalAdvisories = 0;
  let totalSkipped = 0;

  for (const feed of FEEDS) {
    console.log(`\n-> ${feed.url}`);
    let xml: string;
    try {
      xml = await fetchRss(feed.url);
    } catch (err) {
      console.warn(`  fetch failed: ${(err as Error).message}`);
      continue;
    }
    const items = parseRss(xml);
    console.log(`  ${items.length} items`);

    for (const item of items) {
      const ref = extractReference(item.link, item.guid);
      if (!ref) {
        totalSkipped++;
        continue;
      }
      const date = parsePubDate(item.pubDate);
      const text = htmlToText(item.description);
      const summary = text.slice(0, 500);

      if (dryRun) {
        console.log(`  [dry] ${feed.table} ${ref} (${date}) ${item.title.slice(0, 70)}`);
        continue;
      }

      try {
        if (feed.table === "advisory") {
          insertAdvisory!.run(
            ref,
            item.title,
            date,
            null,
            null,
            summary,
            text,
            null,
          );
          totalAdvisories++;
        } else {
          insertGuidance!.run(
            ref,
            item.title,
            null,
            date,
            feed.category,
            feed.series,
            summary,
            text,
            null,
            "current",
          );
          totalGuidance++;
        }
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes("UNIQUE")) {
          totalSkipped++;
        } else {
          console.warn(`  insert failed (${ref}): ${msg}`);
          totalSkipped++;
        }
      }
    }
  }

  if (db) {
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.pragma("journal_mode = DELETE");
    db.close();
  }

  console.log(
    `\nDone: ${totalAdvisories} advisories, ${totalGuidance} guidance, ${totalSkipped} skipped`,
  );
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
