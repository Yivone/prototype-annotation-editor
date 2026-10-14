#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SKILL_NAME = 'prototype-annotation-editor';
const SKILL_VERSION = '1.0.0';
const MANIFEST_NAME = '.prototype-annotation-editor.json';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ASSET_ROOT = path.resolve(SCRIPT_DIR, '..', 'assets', 'runtime');

function fail(message) {
  console.error(`[${SKILL_NAME}] ${message}`);
  process.exit(1);
}

function printHelp() {
  console.log(`Usage:
  node scripts/install.mjs --project-root <path> --prototype-id <id> [options]

Options:
  --workspace-selector <selector>   Default: .plan-platform__workspace
  --layout-root-class <class>       Default: plan-platform
  --layout-shell-class <class>      Default: plan-platform__shell
  --split-class <class>             Default: plan-platform--annotation-split
  --owner-id <id>                   Default: user
  --force                           Overwrite files changed after installation
  --help                            Show this help
`);
}

function parseArgs(argv) {
  const values = {
    projectRoot: process.cwd(),
    prototypeId: '',
    workspaceSelector: '.plan-platform__workspace',
    layoutRootClass: 'plan-platform',
    layoutShellClass: 'plan-platform__shell',
    splitClass: 'plan-platform--annotation-split',
    ownerId: 'user',
    force: false,
  };
  const names = {
    '--project-root': 'projectRoot',
    '--prototype-id': 'prototypeId',
    '--workspace-selector': 'workspaceSelector',
    '--layout-root-class': 'layoutRootClass',
    '--layout-shell-class': 'layoutShellClass',
    '--split-class': 'splitClass',
    '--owner-id': 'ownerId',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help') {
      printHelp();
      process.exit(0);
    }
    if (argument === '--force') {
      values.force = true;
      continue;
    }
    const key = names[argument];
    if (!key) fail(`Unknown argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) fail(`Missing value for ${argument}`);
    values[key] = value;
    index += 1;
  }
  return values;
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(`Cannot parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function replaceRequired(content, search, replacement, label) {
  if (!content.includes(search)) {
    fail(`Bundled runtime is missing the expected ${label} token.`);
  }
  return content.replace(search, replacement);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function configureLayerSource(source, options) {
  let result = source;
  result = replaceRequired(
    result,
    "const DEFAULT_WORKSPACE_SELECTOR = '.plan-platform__workspace';",
    `const DEFAULT_WORKSPACE_SELECTOR = ${JSON.stringify(options.workspaceSelector)};`,
    'workspace selector',
  );
  result = replaceRequired(
    result,
    "const PROTOTYPE_ID = 'ips-annotated';",
    `const PROTOTYPE_ID = ${JSON.stringify(options.prototypeId)};`,
    'prototype id',
  );
  result = replaceRequired(
    result,
    "const DEFAULT_ANNOTATION_OWNER_ID = 'xyf';",
    `const DEFAULT_ANNOTATION_OWNER_ID = ${JSON.stringify(options.ownerId)};`,
    'owner id',
  );
  result = replaceRequired(
    result,
    "const ANNOTATION_OWNER_STORAGE_KEY = 'ips-workbench-annotation-owner-id';",
    `const ANNOTATION_OWNER_STORAGE_KEY = ${JSON.stringify(`prototype-annotation-owner-${options.prototypeId}`)};`,
    'owner storage key',
  );
  result = replaceRequired(
    result,
    "'plan-platform__',",
    `${JSON.stringify(`${options.layoutRootClass}__`)},`,
    'selectable class hint',
  );
  result = replaceRequired(
    result,
    "querySelector('.plan-platform')",
    `querySelector(${JSON.stringify(`.${options.layoutRootClass}`)})`,
    'layout root selector',
  );
  result = result.replaceAll("'plan-platform--annotation-split'", JSON.stringify(options.splitClass));
  return result;
}

function configureCss(source, options) {
  const replacements = [
    ['plan-platform--annotation-split', options.splitClass],
    ['plan-platform__shell', options.layoutShellClass],
    ['plan-platform', options.layoutRootClass],
  ];
  let result = source;
  for (const [from, to] of replacements) {
    result = result.replace(new RegExp(`\\.${escapeRegExp(from)}(?=[\\s.{:#>+~\\[])`, 'gu'), `.${to}`);
  }
  return result;
}

function buildPlannedFiles(projectRoot, prototypeDir, options) {
  const runtimeAssets = [
    'PrototypeAnnotationLayer.tsx',
    'AnnotationRichTextEditor.tsx',
    'AnnotationMarkdownViewer.tsx',
    'annotation.css',
  ];
  const planned = runtimeAssets.map((fileName) => {
    const sourcePath = path.join(ASSET_ROOT, fileName);
    let content = fs.readFileSync(sourcePath, 'utf8');
    if (fileName === 'PrototypeAnnotationLayer.tsx') content = configureLayerSource(content, options);
    if (fileName === 'annotation.css') content = configureCss(content, options);
    return {
      source: `assets/runtime/${fileName}`,
      targetPath: path.join(prototypeDir, fileName),
      content,
    };
  });

  planned.push({
    source: 'assets/runtime/prototypeAnnotationLayerPlugin.ts',
    targetPath: path.join(projectRoot, 'vite-plugins', 'prototypeAnnotationLayerPlugin.ts'),
    content: fs.readFileSync(path.join(ASSET_ROOT, 'prototypeAnnotationLayerPlugin.ts'), 'utf8'),
  });
  return planned;
}

const options = parseArgs(process.argv.slice(2));
const projectRoot = path.resolve(options.projectRoot);
const prototypeIdPattern = /^[a-z0-9][a-z0-9-]*$/u;
const ownerIdPattern = /^[a-z0-9][a-z0-9-]{0,31}$/u;
const cssClassPattern = /^[A-Za-z_][A-Za-z0-9_-]*$/u;

if (!prototypeIdPattern.test(options.prototypeId)) {
  fail('prototype-id must contain lowercase letters, numbers, and hyphens.');
}
if (!ownerIdPattern.test(options.ownerId)) {
  fail('owner-id must be 1-32 lowercase letters, numbers, or hyphens.');
}
if (!options.workspaceSelector.trim() || options.workspaceSelector.includes('\0')) {
  fail('workspace-selector must be a non-empty CSS selector.');
}
for (const [label, value] of [
  ['layout-root-class', options.layoutRootClass],
  ['layout-shell-class', options.layoutShellClass],
  ['split-class', options.splitClass],
]) {
  if (!cssClassPattern.test(value)) fail(`${label} must be a single CSS class name without a leading dot.`);
}
if (!fs.existsSync(path.join(projectRoot, 'package.json'))) {
  fail(`package.json was not found under ${projectRoot}`);
}
if (!fs.existsSync(ASSET_ROOT)) fail(`Bundled runtime assets were not found at ${ASSET_ROOT}`);

const prototypeDir = path.join(projectRoot, 'src', 'prototypes', options.prototypeId);
if (!fs.existsSync(prototypeDir) || !fs.statSync(prototypeDir).isDirectory()) {
  fail(`Target prototype directory does not exist: ${prototypeDir}`);
}

const manifestPath = path.join(prototypeDir, MANIFEST_NAME);
const previousManifest = readJsonIfExists(manifestPath);
const previousFiles = previousManifest?.files && typeof previousManifest.files === 'object'
  ? previousManifest.files
  : {};
const plannedFiles = buildPlannedFiles(projectRoot, prototypeDir, options);
const conflicts = [];

for (const file of plannedFiles) {
  if (!fs.existsSync(file.targetPath)) continue;
  const currentContent = fs.readFileSync(file.targetPath, 'utf8');
  if (currentContent === file.content) continue;
  const relativePath = path.relative(projectRoot, file.targetPath).split(path.sep).join('/');
  const previousHash = previousFiles[relativePath]?.sha256;
  if (!previousHash || previousHash !== sha256(currentContent)) conflicts.push(relativePath);
}

if (conflicts.length > 0 && !options.force) {
  console.error(`[${SKILL_NAME}] Installation stopped because these files contain untracked changes:`);
  for (const filePath of conflicts) console.error(`  - ${filePath}`);
  console.error('Review and preserve those changes. Use --force only after the user explicitly approves overwriting them.');
  process.exit(2);
}

fs.mkdirSync(path.join(projectRoot, 'vite-plugins'), { recursive: true });
fs.mkdirSync(path.join(prototypeDir, 'annotation-sets'), { recursive: true });
fs.mkdirSync(path.join(prototypeDir, 'version-overviews'), { recursive: true });

const writtenFiles = {};
for (const file of plannedFiles) {
  fs.mkdirSync(path.dirname(file.targetPath), { recursive: true });
  const currentContent = fs.existsSync(file.targetPath) ? fs.readFileSync(file.targetPath, 'utf8') : null;
  if (currentContent !== file.content) fs.writeFileSync(file.targetPath, file.content, 'utf8');
  const relativePath = path.relative(projectRoot, file.targetPath).split(path.sep).join('/');
  writtenFiles[relativePath] = { source: file.source, sha256: sha256(file.content) };
}

const layerPath = path.join(prototypeDir, 'annotation-layer.json');
if (!fs.existsSync(layerPath)) {
  const layer = {
    schemaVersion: 1,
    kind: 'prototype-annotation-layer',
    prototypeId: options.prototypeId,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(layerPath, `${JSON.stringify(layer, null, 2)}\n`, 'utf8');
}

const manifestState = {
  schemaVersion: 1,
  skill: SKILL_NAME,
  skillVersion: SKILL_VERSION,
  prototypeId: options.prototypeId,
  configuration: {
    workspaceSelector: options.workspaceSelector,
    layoutRootClass: options.layoutRootClass,
    layoutShellClass: options.layoutShellClass,
    splitClass: options.splitClass,
    ownerId: options.ownerId,
  },
  files: writtenFiles,
};
const previousState = previousManifest && typeof previousManifest === 'object'
  ? {
    schemaVersion: previousManifest.schemaVersion,
    skill: previousManifest.skill,
    skillVersion: previousManifest.skillVersion,
    prototypeId: previousManifest.prototypeId,
    configuration: previousManifest.configuration,
    files: previousManifest.files,
  }
  : null;
const stateChanged = JSON.stringify(previousState) !== JSON.stringify(manifestState);
const now = new Date().toISOString();
const manifest = {
  ...manifestState,
  installedAt: previousManifest?.installedAt || now,
  updatedAt: stateChanged ? now : (previousManifest?.updatedAt || previousManifest?.installedAt || now),
};
const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`;
const currentManifestContent = fs.existsSync(manifestPath) ? fs.readFileSync(manifestPath, 'utf8') : null;
if (currentManifestContent !== manifestContent) fs.writeFileSync(manifestPath, manifestContent, 'utf8');

console.log(`[${SKILL_NAME}] Runtime ${SKILL_VERSION} installed for ${options.prototypeId}.`);
console.log(`Prototype directory: ${prototypeDir}`);
console.log('Next: mount PrototypeAnnotationLayer in the prototype entry and enable prototypeAnnotationLayerPlugin in Vite serve mode.');
console.log(`Then run: node ${path.join(SCRIPT_DIR, 'doctor.mjs')} --project-root ${JSON.stringify(projectRoot)} --prototype-id ${options.prototypeId}`);
