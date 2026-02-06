#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const resolveStateDir = () => {
  const override = process.env.CLAWDBOT_STATE_DIR?.trim();
  return override ? path.resolve(override) : path.join(os.homedir(), ".clawdbot");
};

const resolveConfigPath = (stateDir) => {
  const override = process.env.CLAWDBOT_CONFIG_PATH?.trim();
  return override ? path.resolve(override) : path.join(stateDir, "clawdbot.json");
};

const writeConfigFromEnv = () => {
  const rawB64 = process.env.CLAWDBOT_CONFIG_JSON_B64?.trim();
  const raw = rawB64
    ? Buffer.from(rawB64, "base64").toString("utf8")
    : process.env.CLAWDBOT_CONFIG_JSON?.trim();

  const stateDir = resolveStateDir();
  const configPath = resolveConfigPath(stateDir);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });

  // Check for Telegram token from environment
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN?.trim();

  // If no config JSON provided but we have a Telegram token, create minimal config
  if (!raw) {
    if (telegramToken) {
      const minimalConfig = {
        gateway: { mode: "local" },
        channels: {
          telegram: { enabled: true }
        }
      };
      fs.writeFileSync(configPath, JSON.stringify(minimalConfig, null, 2));
      return configPath;
    }
    return null;
  }

  let payload = raw;
  try {
    const parsed = JSON.parse(raw);
    // Ensure gateway.mode is set to local for Railway deployment
    if (!parsed.gateway) parsed.gateway = {};
    parsed.gateway.mode = "local";

    // Auto-enable Telegram channel if botToken is configured (env or config)
    if (parsed.channels?.telegram || telegramToken) {
      if (!parsed.channels) parsed.channels = {};
      if (!parsed.channels.telegram) parsed.channels.telegram = {};
      // Only set enabled if not explicitly set to false
      if (parsed.channels.telegram.enabled !== false) {
        parsed.channels.telegram.enabled = true;
      }
    }

    payload = JSON.stringify(parsed, null, 2);
  } catch {
    // Leave payload as-is (may be JSON5). We won't force gateway.mode in that case.
  }

  fs.writeFileSync(configPath, payload);
  return configPath;
};

const port = Number(process.env.PORT || 18789);
const gatewayToken = process.env.CLAWDBOT_GATEWAY_TOKEN || "railway-gateway-token";

// Setup Notion
const notionKey = process.env.NOTION_KEY?.trim();
if (notionKey) {
  const notionConfigDir = path.join(os.homedir(), ".config", "notion");
  fs.mkdirSync(notionConfigDir, { recursive: true });
  fs.writeFileSync(path.join(notionConfigDir, "api_key"), notionKey);
}

const notionEnvPath = path.join(os.homedir(), ".clawdbot", "notion.env");
const notionPageId = process.env.NOTION_PAGE_ID?.trim();
const notionDbId = process.env.NOTION_DATABASE_ID?.trim();
if (notionPageId || notionDbId) {
  fs.mkdirSync(path.dirname(notionEnvPath), { recursive: true });
  let content = "";
  if (notionPageId) content += `NOTION_PAGE_ID=${notionPageId}\n`;
  if (notionDbId) content += `NOTION_DATABASE_ID=${notionDbId}\n`;
  fs.writeFileSync(notionEnvPath, content);
}

writeConfigFromEnv();
const args = [
  "scripts/run-node.mjs",
  "gateway",
  "run",
  "--bind",
  "lan",
  "--port",
  String(port),
  "--token",
  gatewayToken,
  "--force",
  "--allow-unconfigured",
];

const child = spawn(process.execPath, args, {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.exit(1);
    return;
  }
  process.exit(code ?? 1);
});
