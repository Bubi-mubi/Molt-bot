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
  if (!raw) return null;

  const stateDir = resolveStateDir();
  const configPath = resolveConfigPath(stateDir);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });

  let payload = raw;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed.gateway) parsed.gateway = {};
    if (!parsed.gateway.mode) parsed.gateway.mode = "local";
    payload = JSON.stringify(parsed, null, 2);
  } catch {
    // Leave payload as-is (may be JSON5). We won't force gateway.mode in that case.
  }

  fs.writeFileSync(configPath, payload);
  return configPath;
};

const port = Number(process.env.PORT || 18789);
writeConfigFromEnv();
const args = [
  "scripts/run-node.mjs",
  "gateway",
  "run",
  "--bind",
  "0.0.0.0",
  "--port",
  String(port),
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
