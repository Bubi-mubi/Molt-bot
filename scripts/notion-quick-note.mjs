#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_KEY_PATH = path.join(os.homedir(), ".config", "notion", "api_key");
const DEFAULT_ENV_FILE = path.join(os.homedir(), ".clawdbot", "notion.env");
const TARGETS_PATH = path.join(os.homedir(), ".clawdbot", "notion-targets.json");
const NOTION_VERSION = "2025-09-03";

function parseArgs(argv) {
  const args = { title: "", body: "", target: "" };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--title" && argv[i + 1]) {
      args.title = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--target" && argv[i + 1]) {
      args.target = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--body" && argv[i + 1]) {
      args.body = argv[i + 1];
      i += 1;
      continue;
    }
  }
  return args;
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    out[key] = val;
  }
  return out;
}

async function notionRequest(key, method, pathName, payload) {
  const url = `https://api.notion.com/v1/${pathName}`;
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Notion API ${response.status}: ${text.slice(0, 300)}`);
  }
  return response.json();
}

async function main() {
  const args = parseArgs(process.argv);
  const title = String(args.title || "").trim();
  if (!title) throw new Error("Missing --title for Notion note.");

  // Check environment variable first (for Railway), then file (for local dev)
  let key = process.env.NOTION_API_KEY || "";
  if (!key && fs.existsSync(DEFAULT_KEY_PATH)) {
    key = fs.readFileSync(DEFAULT_KEY_PATH, "utf8").trim();
  }
  if (!key) {
    throw new Error("Missing Notion API key (check NOTION_API_KEY env or ~/.config/notion/api_key)");
  }

  const env = parseEnvFile(DEFAULT_ENV_FILE);
  let pageId = env.NOTION_PAGE_ID;
  let databaseId = env.NOTION_DATABASE_ID;

  if (args.target && fs.existsSync(TARGETS_PATH)) {
    try {
      const targets = JSON.parse(fs.readFileSync(TARGETS_PATH, "utf8"));
      const entry = targets?.targets?.[args.target];
      if (entry?.pageId) pageId = entry.pageId;
      if (entry?.dbId) databaseId = entry.dbId;
    } catch {
      // ignore targets parse errors
    }
  }

  if (!pageId && !databaseId) {
    throw new Error(`Missing NOTION_PAGE_ID or NOTION_DATABASE_ID in ${DEFAULT_ENV_FILE}`);
  }

  if (pageId) {
    const now = new Date();
    const dateStamp = now
      .toLocaleString("bg-BG", {
        timeZone: "Europe/Sofia",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
      .replace(",", "");
    const baseLine = `${dateStamp} ${title}`.trim();
    const contentLine = args.body && String(args.body).trim() ? `${baseLine} - ${String(args.body).trim()}` : baseLine;
    const children = [
      {
        object: "block",
        type: "to_do",
        to_do: {
          rich_text: [{ text: { content: contentLine } }],
          checked: false,
        },
      },
    ];

    const result = await notionRequest(key, "PATCH", `blocks/${pageId}/children`, {
      children,
    });
    const url = result?.parent?.page_id ? `https://www.notion.so/${result.parent.page_id}` : "";
    process.stdout.write(`Added Notion checklist item: ${title}\n${url}\n`);
    return;
  }

  const payload = {
    parent: { database_id: databaseId },
    properties: {
      Name: {
        title: [{ text: { content: title } }],
      },
    },
  };

  if (args.body && String(args.body).trim()) {
    payload.children = [
      {
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [{ text: { content: String(args.body).trim() } }],
        },
      },
    ];
  }

  const result = await notionRequest(key, "POST", "pages", payload);
  const url = result?.url ?? "";
  process.stdout.write(`Created Notion note: ${title}\n${url}\n`);
}

main().catch((error) => {
  const text = error instanceof Error ? error.message : String(error);
  console.error(text);
  process.exit(1);
});
