#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SKILL_NAME = 'prototype-annotation-editor';
const REQUIRED_RUNTIME_FILES = [
  'PrototypeAnnotationLayer.tsx',
  'AnnotationRichTextEditor.tsx',
  'AnnotationMarkdownViewer.tsx',
  'annotation.css',
];

function parseArgs(argv) {
  const result = { projectRoot: process.cwd(), prototypeId: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--project-root' || argument === '--prototype-id') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
      result[argument === '--project-root' ? 'projectRoot' : 'prototypeId'] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(result.prototypeId)) {
    throw new Error('prototype-id must contain lowercase letters, numbers, and hyphens.');
  }
  return result;
}

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function isPathInside(parentPath, childPath) {
  const relativePath = path.relative(parentPath, childPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

const checks = [];
function ok(message) { checks.push({ level: 'OK', message }); }
function warn(message) { checks.push({ level: 'WARN', message }); }
function error(message) { checks.push({ level: 'ERROR', message }); }

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (caught) {
  console.error(`[${SKILL_NAME}] ${caught instanceof Error ? caught.message : String(caught)}`);
  process.exit(1);
}

const projectRoot = path.resolve(options.projectRoot);
const prototypeDir = path.join(projectRoot, 'src', 'prototypes', options.prototypeId);
const manifestPath = path.join(prototypeDir, '.prototype-annotation-editor.json');
let manifest = null;

if (!fs.existsSync(path.join(projectRoot, 'package.json'))) error(`Missing package.json under ${projectRoot}`);
if (!fs.existsSync(prototypeDir)) error(`Missing prototype directory ${prototypeDir}`);

if (fs.existsSync(manifestPath)) {
  try {
    manifest = readJson(manifestPath);
    ok(`Found installation manifest for runtime ${manifest.skillVersion || 'unknown'}`);
  } catch (caught) {
    error(`Cannot parse ${manifestPath}: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
} else {
  error(`Missing installation manifest ${manifestPath}`);
}

for (const fileName of REQUIRED_RUNTIME_FILES) {
  const filePath = path.join(prototypeDir, fileName);
  if (fs.existsSync(filePath)) ok(`Found ${path.relative(projectRoot, filePath)}`);
  else error(`Missing ${path.relative(projectRoot, filePath)}`);
}

const pluginPath = path.join(projectRoot, 'vite-plugins', 'prototypeAnnotationLayerPlugin.ts');
if (fs.existsSync(pluginPath)) ok('Found Vite save plugin');
else error('Missing vite-plugins/prototypeAnnotationLayerPlugin.ts');

for (const directoryName of ['annotation-sets', 'version-overviews']) {
  const directoryPath = path.join(prototypeDir, directoryName);
  if (fs.existsSync(directoryPath) && fs.statSync(directoryPath).isDirectory()) ok(`Found ${directoryName}/`);
  else error(`Missing ${directoryName}/`);
}

const layerPath = path.join(prototypeDir, 'annotation-layer.json');
if (fs.existsSync(layerPath)) {
  try {
    const layer = readJson(layerPath);
    if (layer.kind !== 'prototype-annotation-layer') error('annotation-layer.json has an invalid kind');
    else if (layer.prototypeId !== options.prototypeId) error('annotation-layer.json prototypeId does not match the target prototype');
    else ok('annotation-layer.json is valid');
  } catch (caught) {
    error(`Cannot parse annotation-layer.json: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
} else {
  error('Missing annotation-layer.json');
}

if (manifest?.files && typeof manifest.files === 'object') {
  for (const [relativePath, record] of Object.entries(manifest.files)) {
    const filePath = path.resolve(projectRoot, relativePath);
    if (!isPathInside(projectRoot, filePath)) {
      error(`Installation manifest contains an unsafe path: ${relativePath}`);
      continue;
    }
    if (!fs.existsSync(filePath)) continue;
    const currentHash = sha256(fs.readFileSync(filePath));
    if (record?.sha256 && currentHash !== record.sha256) warn(`${relativePath} was customized after installation`);
  }
}

const viteConfigName = fs.existsSync(path.join(projectRoot, 'vite.config.ts'))
  ? 'vite.config.ts'
  : fs.readdirSync(projectRoot).find((name) => /^vite\.config\.(?:js|mjs|mts)$/u.test(name));
if (!viteConfigName) {
  error('No vite.config file was found');
} else {
  const viteConfig = fs.readFileSync(path.join(projectRoot, viteConfigName), 'utf8');
  const hasPluginImport = /import\s+\{\s*prototypeAnnotationLayerPlugin\s*\}\s+from\s+['"][^'"]*prototypeAnnotationLayerPlugin['"]/u.test(viteConfig);
  const hasPluginCall = /\bprototypeAnnotationLayerPlugin\s*\(/u.test(viteConfig);
  if (hasPluginImport && hasPluginCall) {
    ok(`Vite save plugin is imported and invoked by ${viteConfigName}`);
    if (!/isServe\s*\?\s*prototypeAnnotationLayerPlugin\s*\(/u.test(viteConfig)) {
      warn(`Could not confirm that ${viteConfigName} limits prototypeAnnotationLayerPlugin to serve mode`);
    }
  } else {
    error(`${viteConfigName} must import and invoke prototypeAnnotationLayerPlugin`);
  }
}

if (fs.existsSync(path.join(projectRoot, 'package.json'))) {
  try {
    const packageJson = readJson(path.join(projectRoot, 'package.json'));
    const dependencies = { ...packageJson.dependencies, ...packageJson.devDependencies, ...packageJson.peerDependencies };
    for (const dependency of ['react', 'react-dom', 'lucide-react']) {
      if (dependencies[dependency]) ok(`Found dependency ${dependency}`);
      else error(`Missing required dependency ${dependency}`);
    }
  } catch (caught) {
    error(`Cannot parse package.json: ${caught instanceof Error ? caught.message : String(caught)}`);
  }
}

if (fs.existsSync(prototypeDir)) {
  const entryCandidates = fs.readdirSync(prototypeDir)
    .filter((name) => name.endsWith('.tsx') && !REQUIRED_RUNTIME_FILES.includes(name));
  const mounted = entryCandidates.some((name) => {
    const source = fs.readFileSync(path.join(prototypeDir, name), 'utf8');
    const importsLayer = /import\s+PrototypeAnnotationLayer\s+from\s+['"]\.\/PrototypeAnnotationLayer['"]/u.test(source);
    const importsStyles = /import\s+['"]\.\/annotation\.css['"]/u.test(source);
    const rendersLayer = /<PrototypeAnnotationLayer\b/u.test(source);
    return importsLayer && importsStyles && rendersLayer;
  });
  if (mounted) ok('Prototype entry references the annotation layer and styles');
  else error('No prototype entry imports and renders PrototypeAnnotationLayer with annotation.css');
}

for (const check of checks) console.log(`[${check.level}] ${check.message}`);
const errorCount = checks.filter((check) => check.level === 'ERROR').length;
const warningCount = checks.filter((check) => check.level === 'WARN').length;
console.log(`Summary: ${errorCount} error(s), ${warningCount} warning(s).`);
if (errorCount > 0) process.exit(1);
