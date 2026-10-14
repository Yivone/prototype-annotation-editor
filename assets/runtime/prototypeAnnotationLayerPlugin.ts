import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

const API_PATH = '/api/prototype-annotation-layer/save';
const ANNOTATION_RECORDS_API_PATH = '/api/prototype-annotations/save';
const VERSION_OVERVIEW_API_PATH = '/api/prototype-version-overviews/save';
const MAX_BODY_BYTES = 25 * 1024 * 1024;

type SaveAnnotationLayerPayload = {
  prototypeId?: unknown;
  source?: unknown;
  annotations?: unknown;
  deletedAnnotationIds?: unknown;
  ownerId?: unknown;
  versionOverviews?: unknown;
};

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

function isSafePrototypeId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/u.test(value);
}

function isSafeVersionOverviewId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/u.test(value);
}

function isSafeAnnotationOwnerId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,31}$/u.test(value);
}

function isSafeAnnotationId(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/u.test(value);
}

function isPathInside(parentPath: string, childPath: string): boolean {
  const relativePath = path.relative(parentPath, childPath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function readJsonBody(req: IncomingMessage): Promise<SaveAnnotationLayerPayload> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        reject(new Error('标注内容超过 25 MB，请删除或压缩部分图片后再保存。'));
        req.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });

    req.on('error', reject);
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('Request body must be valid JSON.'));
      }
    });
  });
}

export function prototypeAnnotationLayerPlugin(projectRoot: string): Plugin {
  const resolvedProjectRoot = path.resolve(projectRoot);

  return {
    name: 'prototype-annotation-layer',
    handleHotUpdate(context) {
      const normalizedPath = context.file.split(path.sep).join('/');
      if (
        /\/src\/prototypes\/[^/]+\/annotation-layer\.json$/u.test(normalizedPath)
        || /\/src\/prototypes\/[^/]+\/annotation-sets\/[^/]+\/[^/]+\.json$/u.test(normalizedPath)
        || /\/src\/prototypes\/[^/]+\/version-overviews\/[^/]+\.json$/u.test(normalizedPath)
      ) {
        return [];
      }
      return undefined;
    },
    configureServer(server) {
      server.middlewares.use(ANNOTATION_RECORDS_API_PATH, async (req, res, next) => {
        if (req.method === 'OPTIONS') {
          res.statusCode = 204;
          res.end();
          return;
        }

        if (req.method !== 'POST') {
          next();
          return;
        }

        try {
          const payload = await readJsonBody(req);
          const prototypeId = typeof payload.prototypeId === 'string' ? payload.prototypeId.trim() : '';
          const ownerId = typeof payload.ownerId === 'string' ? payload.ownerId.trim().toLowerCase() : '';
          if (!isSafePrototypeId(prototypeId)) {
            sendJson(res, 400, { ok: false, message: 'prototypeId is invalid.' });
            return;
          }
          if (!isSafeAnnotationOwnerId(ownerId)) {
            sendJson(res, 400, { ok: false, message: 'ownerId is invalid.' });
            return;
          }
          if (!Array.isArray(payload.annotations) || !Array.isArray(payload.deletedAnnotationIds)) {
            sendJson(res, 400, { ok: false, message: 'annotation changes are invalid.' });
            return;
          }

          const annotationRecords = payload.annotations.map((rawAnnotation) => (
            rawAnnotation && typeof rawAnnotation === 'object' && !Array.isArray(rawAnnotation)
              ? rawAnnotation as Record<string, unknown>
              : null
          ));
          if (annotationRecords.some((annotation) => !annotation)) {
            sendJson(res, 400, { ok: false, message: 'annotation item is invalid.' });
            return;
          }
          const annotationIds = annotationRecords.map((annotation) => (
            typeof annotation?.id === 'string' ? annotation.id.trim() : ''
          ));
          if (annotationIds.some((annotationId) => !isSafeAnnotationId(annotationId))) {
            sendJson(res, 400, { ok: false, message: 'annotation id is invalid.' });
            return;
          }
          if (new Set(annotationIds).size !== annotationIds.length) {
            sendJson(res, 400, { ok: false, message: 'annotation id is duplicated.' });
            return;
          }
          if (annotationRecords.some((annotation) => annotation?.ownerId !== ownerId)) {
            sendJson(res, 400, { ok: false, message: 'annotation owner does not match current owner.' });
            return;
          }

          const deletedAnnotationIds = payload.deletedAnnotationIds.map((annotationId) => (
            typeof annotationId === 'string' ? annotationId.trim() : ''
          ));
          if (deletedAnnotationIds.some((annotationId) => !isSafeAnnotationId(annotationId))) {
            sendJson(res, 400, { ok: false, message: 'deleted annotation id is invalid.' });
            return;
          }
          if (new Set(deletedAnnotationIds).size !== deletedAnnotationIds.length) {
            sendJson(res, 400, { ok: false, message: 'deleted annotation id is duplicated.' });
            return;
          }

          const prototypeDir = path.resolve(resolvedProjectRoot, 'src', 'prototypes', prototypeId);
          const ownerDir = path.resolve(prototypeDir, 'annotation-sets', ownerId);
          if (!isPathInside(resolvedProjectRoot, prototypeDir) || !isPathInside(prototypeDir, ownerDir)) {
            sendJson(res, 400, { ok: false, message: 'target path is invalid.' });
            return;
          }

          fs.mkdirSync(ownerDir, { recursive: true });
          const savedPaths = annotationRecords.map((annotation, index) => {
            const annotationId = annotationIds[index];
            const targetPath = path.resolve(ownerDir, `${annotationId}.json`);
            if (!isPathInside(ownerDir, targetPath)) {
              throw new Error('annotation path is invalid.');
            }
            const standaloneDocument = {
              ...annotation,
              schemaVersion: 1,
              kind: 'prototype-annotation',
              ownerId,
              id: annotationId,
            };
            fs.writeFileSync(targetPath, `${JSON.stringify(standaloneDocument, null, 2)}\n`, 'utf8');
            return path.relative(resolvedProjectRoot, targetPath).split(path.sep).join('/');
          });

          const deletedPaths = deletedAnnotationIds.map((annotationId) => {
            const targetPath = path.resolve(ownerDir, `${annotationId}.json`);
            if (!isPathInside(ownerDir, targetPath)) {
              throw new Error('deleted annotation path is invalid.');
            }
            if (fs.existsSync(targetPath)) {
              fs.unlinkSync(targetPath);
            }
            return path.relative(resolvedProjectRoot, targetPath).split(path.sep).join('/');
          });
          sendJson(res, 200, { ok: true, savedPaths, deletedPaths });
        } catch (error) {
          sendJson(res, 500, { ok: false, message: error instanceof Error ? error.message : 'Save failed.' });
        }
      });

      server.middlewares.use(VERSION_OVERVIEW_API_PATH, async (req, res, next) => {
        if (req.method === 'OPTIONS') {
          res.statusCode = 204;
          res.end();
          return;
        }

        if (req.method !== 'POST') {
          next();
          return;
        }

        try {
          const payload = await readJsonBody(req);
          const prototypeId = typeof payload.prototypeId === 'string' ? payload.prototypeId.trim() : '';
          if (!isSafePrototypeId(prototypeId)) {
            sendJson(res, 400, { ok: false, message: 'prototypeId is invalid.' });
            return;
          }
          if (!Array.isArray(payload.versionOverviews)) {
            sendJson(res, 400, { ok: false, message: 'versionOverviews is invalid.' });
            return;
          }

          const overviewRecords = payload.versionOverviews.map((rawOverview) => (
            rawOverview && typeof rawOverview === 'object' && !Array.isArray(rawOverview)
              ? rawOverview as Record<string, unknown>
              : null
          ));
          if (overviewRecords.some((overview) => !overview)) {
            sendJson(res, 400, { ok: false, message: 'version overview item is invalid.' });
            return;
          }

          const overviewIds = overviewRecords.map((overview) => (
            typeof overview?.id === 'string' ? overview.id.trim() : ''
          ));
          if (overviewIds.some((overviewId) => !isSafeVersionOverviewId(overviewId))) {
            sendJson(res, 400, { ok: false, message: 'version overview id is invalid.' });
            return;
          }
          if (new Set(overviewIds).size !== overviewIds.length) {
            sendJson(res, 400, { ok: false, message: 'version overview id is duplicated.' });
            return;
          }

          const prototypeDir = path.resolve(resolvedProjectRoot, 'src', 'prototypes', prototypeId);
          const overviewDir = path.resolve(prototypeDir, 'version-overviews');
          if (!isPathInside(resolvedProjectRoot, prototypeDir) || !isPathInside(prototypeDir, overviewDir)) {
            sendJson(res, 400, { ok: false, message: 'target path is invalid.' });
            return;
          }

          fs.mkdirSync(overviewDir, { recursive: true });
          const savedPaths = overviewRecords.map((overview, index) => {
            const overviewId = overviewIds[index];
            const targetPath = path.resolve(overviewDir, `${overviewId}.json`);
            if (!isPathInside(overviewDir, targetPath)) {
              throw new Error('version overview path is invalid.');
            }
            const standaloneDocument = {
              ...overview,
              schemaVersion: 1,
              kind: 'prototype-version-overview',
              id: overviewId,
            };
            fs.writeFileSync(targetPath, `${JSON.stringify(standaloneDocument, null, 2)}\n`, 'utf8');
            return path.relative(resolvedProjectRoot, targetPath).split(path.sep).join('/');
          });
          sendJson(res, 200, { ok: true, paths: savedPaths });
        } catch (error) {
          sendJson(res, 500, { ok: false, message: error instanceof Error ? error.message : 'Save failed.' });
        }
      });

      server.middlewares.use(API_PATH, async (req, res, next) => {
        if (req.method === 'OPTIONS') {
          res.statusCode = 204;
          res.end();
          return;
        }

        if (req.method !== 'POST') {
          next();
          return;
        }

        try {
          const payload = await readJsonBody(req);
          const prototypeId = typeof payload.prototypeId === 'string' ? payload.prototypeId.trim() : '';
          if (!isSafePrototypeId(prototypeId)) {
            sendJson(res, 400, { ok: false, message: 'prototypeId is invalid.' });
            return;
          }

          if (!payload.source || typeof payload.source !== 'object' || Array.isArray(payload.source)) {
            sendJson(res, 400, { ok: false, message: 'source is invalid.' });
            return;
          }

          const prototypeDir = path.resolve(resolvedProjectRoot, 'src', 'prototypes', prototypeId);
          const targetPath = path.resolve(prototypeDir, 'annotation-layer.json');
          if (!isPathInside(resolvedProjectRoot, prototypeDir) || !isPathInside(prototypeDir, targetPath)) {
            sendJson(res, 400, { ok: false, message: 'target path is invalid.' });
            return;
          }

          fs.mkdirSync(prototypeDir, { recursive: true });
          fs.writeFileSync(targetPath, `${JSON.stringify(payload.source, null, 2)}\n`, 'utf8');
          sendJson(res, 200, { ok: true, path: path.relative(resolvedProjectRoot, targetPath).split(path.sep).join('/') });
        } catch (error) {
          sendJson(res, 500, { ok: false, message: error instanceof Error ? error.message : 'Save failed.' });
        }
      });
    },
  };
}
