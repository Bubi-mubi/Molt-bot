#!/usr/bin/env node
import { spawn } from "node:child_process";
import process from "node:process";

const port = Number(process.env.PORT || 18789);
const args = [
  "scripts/run-node.mjs",
  "gateway",
  "run",
  "--bind",
  "0.0.0.0",
  "--port",
  String(port),
  "--force",
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
