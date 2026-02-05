#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_KEY_PATH = path.join(os.homedir(), ".config", "notion", "api_key");
const TARGETS_PATH = path.join(os.homedir(), ".clawdbot", "notion-targets.json");
const MAP_PATH = path.join(os.homedir(), ".clawdbot", "notion-schedule-pages.json");
const NOTION_VERSION = "2025-09-03";

function parseArgs(argv) {
  const args = { mode: "add", date: "", text: "" };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--mode" && argv[i + 1]) {
      args.mode = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--date" && argv[i + 1]) {
      args.date = argv[i + 1];
      i += 1;
      continue;
    }
    if (token === "--text" && argv[i + 1]) {
      args.text = argv[i + 1];
      i += 1;
      continue;
    }
  }
  return args;
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

function loadTargets() {
  if (!fs.existsSync(TARGETS_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(TARGETS_PATH, "utf8"));
  } catch {
    return null;
  }
}

function loadPageMap() {
  if (!fs.existsSync(MAP_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(MAP_PATH, "utf8"));
  } catch {
    return {};
  }
}

function savePageMap(map) {
  fs.mkdirSync(path.dirname(MAP_PATH), { recursive: true });
  fs.writeFileSync(MAP_PATH, `${JSON.stringify(map, null, 2)}\n`, "utf8");
}

function formatDateStamp() {
  return new Date()
    .toLocaleString("bg-BG", {
      timeZone: "Europe/Sofia",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
    .replace(",", "");
}

async function main() {
  const args = parseArgs(process.argv);
  const key = fs.existsSync(DEFAULT_KEY_PATH) ? fs.readFileSync(DEFAULT_KEY_PATH, "utf8").trim() : "";
  if (!key) throw new Error("Missing Notion API key.");

  const targets = loadTargets();
  const scheduleTarget = targets?.targets?.daily_schedule;
  const pageId = scheduleTarget?.pageId;
  if (!pageId) throw new Error("Missing daily_schedule.pageId in notion-targets.json");

  const date = args.date || new Date().toISOString().slice(0, 10);
  const text = String(args.text || "").trim();
  if (!text) throw new Error("Missing --text for schedule entry.");

  const map = loadPageMap();
  let dayPageId = map[date];
  if (!dayPageId) {
    const created = await notionRequest(key, "POST", "pages", {
      parent: { page_id: pageId },
      properties: {
        title: {
          title: [{ text: { content: date } }],
        },
      },
    });
    dayPageId = created?.id;
    if (!dayPageId) throw new Error("Failed to create daily schedule page.");
    map[date] = dayPageId;
    savePageMap(map);
  }

  const line = `${formatDateStamp()} ${text}`.trim();
  const result = await notionRequest(key, "PATCH", `blocks/${dayPageId}/children`, {
    children: [
      {
        object: "block",
        type: "to_do",
        to_do: {
          rich_text: [{ text: { content: line } }],
          checked: false,
        },
      },
    ],
  });

  const url = result?.parent?.page_id ? `https://www.notion.so/${result.parent.page_id}` : "";
  process.stdout.write(`Added schedule entry (${date}).\n${url}\n`);
}

main().catch((error) => {
  const text = error instanceof Error ? error.message : String(error);
  console.error(text);
  process.exit(1);
});
