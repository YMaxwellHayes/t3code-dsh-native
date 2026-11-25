#!/usr/bin/env node
// t3code-dsh-native installer: expose the DeepSeek Harness desktop app's bundled CLI,
// create a `t3` ACP profile that inherits the desktop profile's plugins and settings,
// and register a native T3 Code provider instance (official Local ACP command driver).
//
// Zero dependencies. Idempotent. Backs up T3 settings before every write.
// Ownership: only touches paths it created (marker files); refuses foreign directories.

import { existsSync, lstatSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, symlinkSync, readlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

const HOME = homedir();
const DSH_HOME = process.env.DSH_HOME || join(HOME, '.dsh');
const T3_SETTINGS = join(process.env.T3CODE_HOME || join(HOME, '.t3'), 'userdata', 'settings.json');
const APP = '/Applications/DeepSeek Harness.app/Contents/Resources';
const BUNDLED_CLI = join(APP, 'runtime/cli/bin/dsh');
const WRAPPER = join(HOME, '.local/bin/dsh');
const MARKER = '.t3code-dsh-native';
const SOURCE_PROFILE = process.env.DSH_SOURCE_PROFILE || 'desktop';
const TARGET_PROFILE = 't3';
const INSTANCE_ID = 'dsh';
const BRAND_COLOR = '#4D6BFE'; // official DeepSeek brand blue (assets/dsh-logo.svg)

const ACP_BUNDLE = '@deepseek-ai/dsh-acp-app';
const BASE_BUNDLE = '@deepseek-ai/dsh-base';
const APP_BUNDLES = new Set([
  '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless',
  '@deepseek-ai/dsh-sdk-app', '@deepseek-ai/dsh-sdk-minimal',
  'ds-bot', '@deepseek-harness-tui/dsh-tui',
]);

function log(msg) { console.log(`[install] ${msg}`); }
function fail(msg) { console.error(`[install] REFUSED: ${msg}`); process.exit(1); }
function writeIfChanged(path, content) {
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return false;
  writeFileSync(path, content);
  return true;
}

// 1. CLI wrapper -------------------------------------------------------------
if (!existsSync(BUNDLED_CLI)) fail(`bundled CLI not found: ${BUNDLED_CLI} (is DeepSeek Harness.app installed?)`);
mkdirSync(join(HOME, '.local/bin'), { recursive: true });
const wrapperBody = `#!/bin/sh\nexec "${BUNDLED_CLI}" "$@"\n`;
if (!existsSync(WRAPPER) || readFileSync(WRAPPER, 'utf8') !== wrapperBody) {
  if (existsSync(WRAPPER)) {
    const cur = readFileSync(WRAPPER, 'utf8');
    if (!cur.includes('DeepSeek Harness.app')) fail(`${WRAPPER} exists and is not ours; left untouched`);
  }
  writeFileSync(WRAPPER, wrapperBody, { mode: 0o755 });
  log(`wrapper written: ${WRAPPER}`);
} else log('wrapper already current');
const version = execFileSync(WRAPPER, ['--version'], { encoding: 'utf8' }).trim();
log(`dsh version: ${version}`);

// 2. Variant profile ---------------------------------------------------------
const profilesDir = join(DSH_HOME, 'profiles');
const sourceDir = join(profilesDir, SOURCE_PROFILE);
const targetDir = join(profilesDir, TARGET_PROFILE);
if (!existsSync(sourceDir)) fail(`source profile not found: ${sourceDir}`);

const sourcePkg = JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8'));
const bundles = (sourcePkg.dsh?.profile?.bundles || []).filter(b => !APP_BUNDLES.has(b) && b !== ACP_BUNDLE);
const baseAt = bundles.indexOf(BASE_BUNDLE);
if (baseAt >= 0) bundles.splice(baseAt + 1, 0, ACP_BUNDLE); else bundles.unshift(ACP_BUNDLE);
const pkg = { ...sourcePkg, name: `dsh-profile-${TARGET_PROFILE}`, dsh: { ...sourcePkg.dsh, profile: { ...sourcePkg.dsh?.profile, bundles } } };

const targetState = existsSync(targetDir) ? lstatSync(targetDir) : null;
if (targetState) {
  if (targetState.isSymbolicLink()) fail(`${targetDir} is a symlink`);
  if (!targetState.isDirectory()) fail(`${targetDir} is not a directory`);
  if (!existsSync(join(targetDir, MARKER))) fail(`${targetDir} exists without our marker; left untouched`);
}
mkdirSync(targetDir, { recursive: true });
const markerPath = join(targetDir, MARKER);
if (!existsSync(markerPath)) writeFileSync(markerPath, `source: ${SOURCE_PROFILE}\ncreated: ${new Date().toISOString()}\n`);
writeIfChanged(join(targetDir, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
for (const f of ['cordis.patch.yml', 'cordis.yml']) {
  const src = join(sourceDir, f);
  if (existsSync(src)) writeIfChanged(join(targetDir, f), readFileSync(src, 'utf8'));
}
const modulesSrc = join(sourceDir, 'node_modules');
const modulesDst = join(targetDir, 'node_modules');
if (existsSync(modulesSrc)) {
  const st = existsSync(modulesDst) ? lstatSync(modulesDst) : null;
  if (!st) symlinkSync(modulesSrc, modulesDst);
  else if (st.isSymbolicLink() && readlinkSync(modulesDst) !== modulesSrc) fail(`${modulesDst} points elsewhere; left untouched`);
}
log(`profile ${TARGET_PROFILE}: ${bundles.length} bundles (ACP app + inherited plugins)`);

// 3. T3 provider instance ----------------------------------------------------
const settings = JSON.parse(readFileSync(T3_SETTINGS, 'utf8'));
const instances = settings.providerInstances || (settings.providerInstances = {});
const desired = {
  driver: 'acpRegistry',
  enabled: true,
  displayName: 'dsh',
  accentColor: BRAND_COLOR,
  config: { source: 'local', commandPath: WRAPPER, commandArgs: ['--profile', TARGET_PROFILE], enabled: true },
};
const prev = instances[INSTANCE_ID];
if (prev && prev.driver !== 'acpRegistry') fail(`existing ${INSTANCE_ID} instance uses another driver; left untouched`);
if (JSON.stringify(prev) !== JSON.stringify(desired)) {
  const backup = `${T3_SETTINGS}.bak-dsh-native-${Date.now()}`;
  copyFileSync(T3_SETTINGS, backup);
  instances[INSTANCE_ID] = desired;
  const tmp = `${T3_SETTINGS}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  renameSync(tmp, T3_SETTINGS);
  log(`T3 instance '${INSTANCE_ID}' written (backup: ${backup})`);
} else log('T3 instance already current');

// 4. Model preferences (order + favorite) — only when absent, never overwrite user choices
const ACCOUNT_FLASH = '["deepseek-account","deepseek-flash"]';
const prefs = settings.providerModelPreferences || (settings.providerModelPreferences = {});
let prefsChanged = false;
if (!prefs[INSTANCE_ID]) {
  prefs[INSTANCE_ID] = {
    modelOrder: [
      ACCOUNT_FLASH,
      '["deepseek-official","deepseek-flash"]',
      '["deepseek-official","deepseek-v4-flash"]',
      '["deepseek-account","deepseek-v4-pro"]',
      '["deepseek-official","deepseek-v4-pro"]',
    ],
    hiddenModels: [],
  };
  prefsChanged = true;
}
const favorites = settings.favorites || (settings.favorites = []);
if (!favorites.some(f => f.provider === INSTANCE_ID)) {
  favorites.push({ provider: INSTANCE_ID, model: ACCOUNT_FLASH });
  prefsChanged = true;
}
if (prefsChanged) {
  const backup = `${T3_SETTINGS}.bak-dsh-native-${Date.now()}`;
  copyFileSync(T3_SETTINGS, backup);
  const tmp = `${T3_SETTINGS}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  renameSync(tmp, T3_SETTINGS);
  log('model preferences written (desktop default model first + favorite)');
} else log('model preferences already present, untouched');

log('done. Verify: node scripts/verify.mjs');