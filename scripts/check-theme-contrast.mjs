import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/App.css", import.meta.url), "utf8");
const themes = [
  ["midnight", /:root\s*\{([\s\S]*?)\n\}/],
  ["graphite", /\.app\[data-theme="graphite"\]\s*\{([^}]*)\}/],
  ["warm", /\.app\[data-theme="warm"\]\s*\{([^}]*)\}/],
];

function readTokens(block) {
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map(([, key, color]) => [key, color]));
}

function luminance(hex) {
  const channels = [0, 2, 4].map((offset) => Number.parseInt(hex.slice(1 + offset, 3 + offset), 16) / 255).map((value) => value <= .03928 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return .2126 * channels[0] + .7152 * channels[1] + .0722 * channels[2];
}

function contrast(left, right) {
  const [light, dark] = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (light + .05) / (dark + .05);
}

const root = readTokens(themes[0][1].exec(css)?.[1] ?? "");
let failed = false;
for (const [name, pattern] of themes) {
  const tokens = { ...root, ...readTokens(pattern.exec(css)?.[1] ?? "") };
  for (const [foreground, background] of [["ink", "app-background"], ["muted", "app-background"], ["quiet", "app-background"], ["on-accent", "accent"], ["on-danger", "danger"]]) {
    const ratio = contrast(tokens[foreground], tokens[background]);
    if (ratio < 4.5) { console.error(`${name}: ${foreground} / ${background} is ${ratio.toFixed(2)}:1`); failed = true; }
    else console.log(`${name}: ${foreground} / ${background} is ${ratio.toFixed(2)}:1`);
  }
}
if (failed) process.exitCode = 1;
