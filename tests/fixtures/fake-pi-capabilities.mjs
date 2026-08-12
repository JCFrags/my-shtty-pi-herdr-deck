#!/usr/bin/env node
if (process.argv.includes("--help")) {
  console.log("  --thinking <level> off minimal low medium high");
  process.exit(0);
}
if (process.argv.includes("--list-models")) {
  console.log("provider model context output reasoning images");
  console.log("openai-codex gpt-5.6-luna 1m 128k yes no");
  console.log("openai-codex gpt-5.6-sol 1m 128k yes no");
  process.exit(0);
}
process.exit(1);
