#!/usr/bin/env node

/**
 * Austrian Cybersecurity MCP — stdio entry point.
 *
 * Provides MCP tools for querying CERT.at (Austrian Computer Emergency
 * Response Team) guidelines, technical reports, security advisories,
 * and Austrian cybersecurity frameworks (ITSG, Mindeststandard).
 *
 * Tool prefix: at_cyber_
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { searchGuidance, getGuidance, searchAdvisories, getAdvisory, listFrameworks } from "./db.js";
import { buildCitation } from './citation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as { version: string };
  pkgVersion = pkg.version;
} catch { /* fallback */ }

const SERVER_NAME = "austrian-cybersecurity-mcp";

const TOOLS = [
  {
    name: "at_cyber_search_guidance",
    description: "Full-text search across CERT.at guidelines and technical reports. Covers Austrian IT Security Handbook (ITSG), Mindeststandard, CERT.at technical recommendations, and NIS Act implementation guides. Returns matching documents with reference, title, series, and summary.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query in German (e.g., 'Kryptographie TLS', 'NIS Mindeststandard', 'Patch Management')" },
        type: { type: "string", enum: ["technical_guideline", "nis_guide", "technical_report", "recommendation"], description: "Filter by document type. Optional." },
        series: { type: "string", enum: ["ITSG", "CERT.at", "Mindeststandard"], description: "Filter by series. Optional." },
        status: { type: "string", enum: ["current", "superseded", "draft"], description: "Filter by document status. Optional." },
        limit: { type: "number", description: "Maximum number of results to return. Defaults to 20." },
      },
      required: ["query"],
    },
  },
  {
    name: "at_cyber_get_guidance",
    description: "Get a specific CERT.at guidance document by reference (e.g., 'ITSG-33', 'CERT.at-TLP-2024-01').",
    inputSchema: { type: "object" as const, properties: { reference: { type: "string", description: "Document reference" } }, required: ["reference"] },
  },
  {
    name: "at_cyber_search_advisories",
    description: "Search CERT.at security advisories and warnings. Returns advisories with severity, affected products, and CVE references where available.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Search query (e.g., 'kritische Schwachstelle', 'Ransomware', 'Phishing')" },
        severity: { type: "string", enum: ["critical", "high", "medium", "low"], description: "Filter by severity level. Optional." },
        limit: { type: "number", description: "Maximum number of results to return. Defaults to 20." },
      },
      required: ["query"],
    },
  },
  {
    name: "at_cyber_get_advisory",
    description: "Get a specific CERT.at security advisory by reference (e.g., 'CERT.at-2024-0001').",
    inputSchema: { type: "object" as const, properties: { reference: { type: "string", description: "CERT.at advisory reference" } }, required: ["reference"] },
  },
  {
    name: "at_cyber_list_frameworks",
    description: "List all CERT.at frameworks and standard series covered in this MCP, including ITSG, Mindeststandard, and CERT.at advisory series.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "at_cyber_about",
    description: "Return metadata about this MCP server: version, data source, coverage, and tool list.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
];

const SearchGuidanceArgs = z.object({
  query: z.string().min(1),
  type: z.enum(["technical_guideline", "nis_guide", "technical_report", "recommendation"]).optional(),
  series: z.enum(["ITSG", "CERT.at", "Mindeststandard"]).optional(),
  status: z.enum(["current", "superseded", "draft"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});
const GetGuidanceArgs = z.object({ reference: z.string().min(1) });
const SearchAdvisoriesArgs = z.object({
  query: z.string().min(1),
  severity: z.enum(["critical", "high", "medium", "low"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});
const GetAdvisoryArgs = z.object({ reference: z.string().min(1) });

function textContent(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}
function errorContent(message: string) {
  return { content: [{ type: "text" as const, text: message }], isError: true as const };
}

const server = new Server({ name: SERVER_NAME, version: pkgVersion }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    switch (name) {
      case "at_cyber_search_guidance": {
        const parsed = SearchGuidanceArgs.parse(args);
        return textContent({ results: searchGuidance({ query: parsed.query, type: parsed.type, series: parsed.series, status: parsed.status, limit: parsed.limit }), count: searchGuidance({ query: parsed.query, type: parsed.type, series: parsed.series, status: parsed.status, limit: parsed.limit }).length });
      }
      case "at_cyber_get_guidance": {
        const parsed = GetGuidanceArgs.parse(args);
        const doc = getGuidance(parsed.reference);
        if (!doc) return errorContent(`Guidance document not found: ${parsed.reference}`);
        return textContent({
          ...(typeof doc === 'object' ? doc : { data: doc }),
          _citation: buildCitation(
            doc.reference || parsed.reference,
            doc.title || doc.name || parsed.reference,
            'at_cyber_get_guidance',
            { reference: parsed.reference },
            doc.url || doc.source_url || null,
          ),
        });
      }
      case "at_cyber_search_advisories": {
        const parsed = SearchAdvisoriesArgs.parse(args);
        const results = searchAdvisories({ query: parsed.query, severity: parsed.severity, limit: parsed.limit });
        return textContent({ results, count: results.length });
      }
      case "at_cyber_get_advisory": {
        const parsed = GetAdvisoryArgs.parse(args);
        const advisory = getAdvisory(parsed.reference);
        if (!advisory) return errorContent(`Advisory not found: ${parsed.reference}`);
        return textContent({
          ...(typeof advisory === 'object' ? advisory : { data: advisory }),
          _citation: buildCitation(
            advisory.reference || parsed.reference,
            advisory.title || advisory.subject || parsed.reference,
            'at_cyber_get_advisory',
            { reference: parsed.reference },
            advisory.url || advisory.source_url || null,
          ),
        });
      }
      case "at_cyber_list_frameworks": {
        const frameworks = listFrameworks();
        return textContent({ frameworks, count: frameworks.length });
      }
      case "at_cyber_about":
        return textContent({
          name: SERVER_NAME, version: pkgVersion,
          description: "CERT.at (Austrian Computer Emergency Response Team) MCP server. Provides access to Austrian IT Security Handbook (ITSG), Mindeststandard, CERT.at technical recommendations, and security advisories.",
          data_source: "CERT.at (https://www.cert.at/)",
          coverage: { guidance: "ITSG (IT Security Handbook), Mindeststandard, CERT.at technical recommendations, NIS implementation guides", advisories: "CERT.at security advisories and warnings", frameworks: "ITSG, Mindeststandard, CERT.at advisory series" },
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
        });
      default:
        return errorContent(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return errorContent(`Error executing ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} v${pkgVersion} running on stdio\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
