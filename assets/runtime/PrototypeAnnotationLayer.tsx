import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, Eye, GripVertical, History, MousePointer2, PencilLine, Plus, Save, Search, Trash2, UserRound, X } from 'lucide-react';
import AnnotationMarkdownViewer, { markdownToRichTextHtml } from './AnnotationMarkdownViewer';
import AnnotationRichTextEditor from './AnnotationRichTextEditor';
import annotationLayerDocument from './annotation-layer.json';

const importedVersionOverviewSources = Object.values(import.meta.glob(
  './version-overviews/*.json',
  { eager: true, import: 'default' },
)) as unknown[];
const importedAnnotationSources = Object.values(import.meta.glob(
  './annotation-sets/*/*.json',
  { eager: true, import: 'default' },
)) as unknown[];

type AnnotationLayerMode = 'closed' | 'view' | 'edit';
type AnnotationLayerTool = 'idle' | 'select';

type RectLike = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type AnnotationLocator = {
  selectors: string[];
  path: number[];
  fingerprint: string;
};

type AnnotationFallbackRect = {
  xPercent: number;
  yPercent: number;
  widthPercent: number;
  heightPercent: number;
};

type AnnotationVersion = {
  id: string;
  label: string;
  markdown: string;
  richTextHtml?: string;
  adjustmentNote: string;
  adjustmentDate: string;
  author: string;
  createdAt: string;
  updatedAt: string;
};

type AnnotationRecord = {
  id: string;
  ownerId: string;
  pageId: string;
  title: string;
  locator: AnnotationLocator;
  fallbackRect: AnnotationFallbackRect;
  markdown: string;
  richTextHtml?: string;
  versions?: AnnotationVersion[];
  createdAt: string;
  updatedAt: string;
};

type VersionOverview = {
  id: string;
  label: string;
  markdown: string;
  richTextHtml?: string;
  createdAt: string;
  updatedAt: string;
};

type AnnotationLayerDocument = {
  schemaVersion: 1;
  kind: 'prototype-annotation-layer';
  prototypeId: string;
  updatedAt: string;
  versionOverviews: VersionOverview[];
  annotations: AnnotationRecord[];
};

type AnnotationLayerBox = {
  record: AnnotationRecord;
  index: number;
  rect: RectLike;
  usedFallback: boolean;
};

type DragSelection = {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
};

type ToolbarPosition = {
  left: number;
  top: number;
};

type ToolbarDrag = ToolbarPosition & {
  pointerId: number;
  startX: number;
  startY: number;
};

type PanelResize = {
  pointerId: number;
  startWidth: number;
  startX: number;
};

type PrototypeAnnotationLayerProps = {
  currentPageId: string;
  currentPageTitle: string;
  workspaceSelector?: string;
  prototypeId?: string;
};

const DEFAULT_WORKSPACE_SELECTOR = '.plan-platform__workspace';
const ANNOTATION_SAVE_ENDPOINT = '/api/prototype-annotations/save';
const VERSION_OVERVIEW_SAVE_ENDPOINT = '/api/prototype-version-overviews/save';
const PROTOTYPE_ID = 'ips-annotated';
const DEFAULT_ANNOTATION_OWNER_ID = 'xyf';
const ANNOTATION_OWNER_STORAGE_KEY = 'ips-workbench-annotation-owner-id';
const MAX_SAVE_PAYLOAD_BYTES = 25 * 1024 * 1024;
const MIN_PANEL_WIDTH = 300;
const MAX_PANEL_WIDTH = 720;
const ENABLE_EDITING = import.meta.env.DEV;

function isHTMLElement(value: unknown): value is HTMLElement {
  return value instanceof HTMLElement;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeAnnotationOwnerId(value: string) {
  return value.trim().toLowerCase();
}

function isSafeAnnotationOwnerId(value: string) {
  return /^[a-z0-9][a-z0-9-]{0,31}$/u.test(value);
}

function getInitialAnnotationOwnerId() {
  try {
    const storedOwnerId = normalizeAnnotationOwnerId(window.localStorage.getItem(ANNOTATION_OWNER_STORAGE_KEY) || '');
    return isSafeAnnotationOwnerId(storedOwnerId) ? storedOwnerId : DEFAULT_ANNOTATION_OWNER_ID;
  } catch {
    return DEFAULT_ANNOTATION_OWNER_ID;
  }
}

function todayDateInput() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatAdjustmentVersionLabel(date: string) {
  const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  return match ? `${match[1].slice(2)}${match[2]}${match[3]}调整` : '调整版本';
}

function fuzzyMatchVersionLabel(label: string, query: string) {
  const normalizedLabel = label.toLocaleLowerCase().replace(/\s+/gu, '');
  const normalizedQuery = query.toLocaleLowerCase().replace(/\s+/gu, '');
  if (!normalizedQuery) {
    return true;
  }
  if (normalizedLabel.includes(normalizedQuery)) {
    return true;
  }

  let queryIndex = 0;
  for (const character of normalizedLabel) {
    if (character === normalizedQuery[queryIndex]) {
      queryIndex += 1;
      if (queryIndex === normalizedQuery.length) {
        return true;
      }
    }
  }
  return false;
}

function getPanelWidthLimit() {
  return Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, window.innerWidth - 280));
}

function escapeCss(value: string) {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/gu, '\\$&');
}

function getDocumentRoot(): Document | null {
  return typeof document === 'undefined' ? null : document;
}

function isElementVisible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width < 4 || rect.height < 4) {
    return false;
  }

  const style = window.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') > 0;
}

function getElementFingerprint(element: HTMLElement): string {
  const className = Array.from(element.classList)
    .filter((classNameItem) => classNameItem && !classNameItem.includes('--'))
    .slice(0, 4)
    .join('.');
  const text = (element.textContent || '').replace(/\s+/gu, ' ').trim().slice(0, 24);
  return [element.tagName.toLowerCase(), className ? `class=${className}` : '', text ? `text=${text}` : '']
    .filter(Boolean)
    .join('|');
}

function getElementPath(root: HTMLElement, element: HTMLElement): number[] {
  const path: number[] = [];
  let current: HTMLElement | null = element;

  while (current && current !== root) {
    const parent: HTMLElement | null = current.parentElement;
    if (!parent) {
      break;
    }
    const index = Array.from(parent.children).indexOf(current);
    path.unshift(index);
    current = parent;
  }

  return path;
}

function getElementFromPath(root: HTMLElement, path: number[]): HTMLElement | null {
  let current: HTMLElement | null = root;
  for (const index of path) {
    if (!current) {
      return null;
    }
    const child = current.children.item(index);
    current = isHTMLElement(child) ? child : null;
  }
  return current;
}

function buildCssSelector(root: HTMLElement, element: HTMLElement): string[] {
  const selectorSegments: string[] = [];
  let current: HTMLElement | null = element;

  while (current && current !== root) {
    const currentElement: HTMLElement = current;
    const tag = currentElement.tagName.toLowerCase();
    const anchor = currentElement.getAttribute('data-prototype-annotation-anchor');
    if (anchor) {
      selectorSegments.unshift(`[data-prototype-annotation-anchor="${anchor}"]`);
      break;
    }

    const classes = Array.from(currentElement.classList as DOMTokenList)
      .filter((className: string) => className && !className.includes('--'))
      .slice(0, 2)
      .map((className: string) => escapeCss(className));
    const parent: HTMLElement | null = currentElement.parentElement;
    const sameTagSiblings: HTMLElement[] = parent
      ? Array.from(parent.children).filter((child): child is HTMLElement => isHTMLElement(child) && child.tagName === currentElement.tagName)
      : [];
    const sameTagIndex = parent ? sameTagSiblings.indexOf(currentElement) : 0;
    const classSelector = classes.length > 0 ? `.${classes.join('.')}` : '';
    const nthSelector = sameTagSiblings.length > 1 ? `:nth-of-type(${sameTagIndex + 1})` : '';
    selectorSegments.unshift(`${tag}${classSelector}${nthSelector}`);
    current = parent;
  }

  return selectorSegments.length > 0 ? [selectorSegments.join(' > ')] : [];
}

function normalizeRect(rect: Pick<RectLike, 'left' | 'top' | 'width' | 'height'>): RectLike {
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function getIntersectionArea(leftA: number, topA: number, rightA: number, bottomA: number, leftB: number, topB: number, rightB: number, bottomB: number) {
  const left = Math.max(leftA, leftB);
  const top = Math.max(topA, topB);
  const right = Math.min(rightA, rightB);
  const bottom = Math.min(bottomA, bottomB);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function getWorkspaceRoot(selector: string): HTMLElement | null {
  const doc = getDocumentRoot();
  if (!doc) {
    return null;
  }
  const root = doc.querySelector(selector);
  return isHTMLElement(root) ? root : null;
}

function isSelectableElement(element: HTMLElement): boolean {
  if (!isElementVisible(element)) {
    return false;
  }

  const tag = element.tagName.toLowerCase();
  if (['html', 'body', 'main', 'script', 'style', 'svg', 'path'].includes(tag)) {
    return false;
  }

  const role = element.getAttribute('role') || '';
  const selectableClassHints = [
    'plan-platform__',
    'stock-detail__',
    'basic-data__',
    'cancel-advice__',
    'label-change__',
    'shipping-advice__',
    'stock-board__',
    'advice-page__',
    'advice-table__',
  ];

  return (
    selectableClassHints.some((hint) => Array.from(element.classList).some((className) => className.includes(hint))) ||
    ['section', 'article', 'table', 'thead', 'tbody', 'tr', 'button', 'aside', 'div'].includes(tag) ||
    role === 'table' ||
    role === 'grid'
  );
}

function scoreSelectableElement(element: HTMLElement, selection: RectLike): number {
  const rect = element.getBoundingClientRect();
  const intersection = getIntersectionArea(
    rect.left,
    rect.top,
    rect.left + rect.width,
    rect.top + rect.height,
    selection.left,
    selection.top,
    selection.left + selection.width,
    selection.top + selection.height
  );
  if (intersection <= 0) {
    return -Infinity;
  }

  const selectionArea = Math.max(1, selection.width * selection.height);
  const elementArea = Math.max(1, rect.width * rect.height);
  const selectionCoverage = intersection / selectionArea;
  const elementCoverage = intersection / elementArea;
  const sizeRatio = elementArea / selectionArea;
  const tag = element.tagName.toLowerCase();
  const className = Array.from(element.classList).join(' ');
  const anchor = element.getAttribute('data-prototype-annotation-anchor') || '';
  const hasAnchor = Boolean(anchor);
  const isPageRootAnchor = anchor.endsWith('-root');

  let score = selectionCoverage * 5 + elementCoverage * 3;
  if (hasAnchor) {
    score += 2.5;
  }
  if (isPageRootAnchor && elementCoverage < 0.85) {
    score -= 7;
  }
  if (['section', 'article', 'table', 'aside'].includes(tag)) {
    score += 0.9;
  }
  if (['button'].includes(tag)) {
    score += 0.4;
  }
  if (/__table-card|__filters|__workflow-drawer|__confirm-drawer|__table-wrap|__section/u.test(className)) {
    score += 0.7;
  }
  if (sizeRatio > 12 && selectionCoverage < 0.7) {
    score -= 1.5;
  }
  if (sizeRatio > 4 && elementCoverage < 0.42) {
    score -= 4.5;
  }
  if (sizeRatio > 12 && elementCoverage < 0.22) {
    score -= 3.5;
  }
  if (sizeRatio < 0.12) {
    score -= 0.6;
  }

  return score;
}

function shouldUseElementTarget(element: HTMLElement, selection: RectLike): boolean {
  const rect = element.getBoundingClientRect();
  const intersection = getIntersectionArea(
    rect.left,
    rect.top,
    rect.left + rect.width,
    rect.top + rect.height,
    selection.left,
    selection.top,
    selection.left + selection.width,
    selection.top + selection.height
  );
  if (intersection <= 0) {
    return false;
  }

  const selectionArea = Math.max(1, selection.width * selection.height);
  const elementArea = Math.max(1, rect.width * rect.height);
  const selectionCoverage = intersection / selectionArea;
  const elementCoverage = intersection / elementArea;
  const sizeRatio = elementArea / selectionArea;
  const anchor = element.getAttribute('data-prototype-annotation-anchor') || '';
  const className = Array.from(element.classList).join(' ');
  const isPageRootAnchor = anchor.endsWith('-root');
  const isListLikeModule = /__table-card|__table-wrap|__table|advice-table|basic-data__table|stock-detail__table/u.test(className);

  if (isPageRootAnchor && elementCoverage < 0.85) {
    return false;
  }

  if (!isListLikeModule && sizeRatio > 3.2 && selectionCoverage > 0.88 && elementCoverage < 0.55) {
    return false;
  }

  if (isListLikeModule && sizeRatio > 4.5 && elementCoverage < 0.34) {
    return false;
  }

  return true;
}

function createFallbackRect(rect: RectLike, workspaceRect: RectLike): AnnotationFallbackRect {
  const width = workspaceRect.width || 1;
  const height = workspaceRect.height || 1;
  return {
    xPercent: ((rect.left - workspaceRect.left) / width) * 100,
    yPercent: ((rect.top - workspaceRect.top) / height) * 100,
    widthPercent: (rect.width / width) * 100,
    heightPercent: (rect.height / height) * 100,
  };
}

function resolveFallbackRect(fallbackRect: AnnotationFallbackRect, workspaceRect: RectLike): RectLike {
  return {
    left: workspaceRect.left + workspaceRect.width * (fallbackRect.xPercent / 100),
    top: workspaceRect.top + workspaceRect.height * (fallbackRect.yPercent / 100),
    width: workspaceRect.width * (fallbackRect.widthPercent / 100),
    height: workspaceRect.height * (fallbackRect.heightPercent / 100),
  };
}

function normalizeAnnotationVersion(raw: unknown, index: number, annotationId: string): AnnotationVersion {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const adjustmentDate = typeof record.adjustmentDate === 'string' ? record.adjustmentDate : '';
  return {
    id: typeof record.id === 'string' && record.id.trim() ? record.id : `${annotationId}-version-${index + 1}`,
    label: typeof record.label === 'string' && record.label.trim()
      ? record.label
      : (index === 0 ? '初始版本' : formatAdjustmentVersionLabel(adjustmentDate)),
    markdown: typeof record.markdown === 'string' ? record.markdown : '',
    richTextHtml: typeof record.richTextHtml === 'string' ? record.richTextHtml : undefined,
    adjustmentNote: typeof record.adjustmentNote === 'string' ? record.adjustmentNote : '',
    adjustmentDate,
    author: typeof record.author === 'string' ? record.author : '',
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : nowIso(),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : nowIso(),
  };
}

function normalizeVersionOverview(raw: unknown, index: number): VersionOverview {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    id: typeof record.id === 'string' && record.id.trim() ? record.id : `version-overview-${index + 1}`,
    label: typeof record.label === 'string' ? record.label : '',
    markdown: typeof record.markdown === 'string' ? record.markdown : '',
    richTextHtml: typeof record.richTextHtml === 'string' ? record.richTextHtml : undefined,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : nowIso(),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : nowIso(),
  };
}

function normalizeAnnotationRecord(raw: unknown, index: number, prototypeId: string): AnnotationRecord {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const locatorRecord = record.locator && typeof record.locator === 'object' ? (record.locator as Record<string, unknown>) : {};
  const fallbackRectRecord = record.fallbackRect && typeof record.fallbackRect === 'object' ? (record.fallbackRect as Record<string, unknown>) : {};
  const annotationId = typeof record.id === 'string' && record.id.trim() ? record.id : `annotation-${index + 1}`;
  const versions = Array.isArray(record.versions)
    ? record.versions.map((item, versionIndex) => normalizeAnnotationVersion(item, versionIndex, annotationId))
    : [];

  return {
    id: annotationId,
    ownerId: typeof record.ownerId === 'string' && isSafeAnnotationOwnerId(normalizeAnnotationOwnerId(record.ownerId))
      ? normalizeAnnotationOwnerId(record.ownerId)
      : DEFAULT_ANNOTATION_OWNER_ID,
    pageId: typeof record.pageId === 'string' ? record.pageId : '',
    title: typeof record.title === 'string' ? record.title : `标注 ${index + 1}`,
    locator: {
      selectors: Array.isArray(locatorRecord.selectors) ? locatorRecord.selectors.filter((item): item is string => typeof item === 'string') : [],
      path: Array.isArray(locatorRecord.path) ? locatorRecord.path.filter((item): item is number => Number.isInteger(item)) : [],
      fingerprint: typeof locatorRecord.fingerprint === 'string' ? locatorRecord.fingerprint : prototypeId,
    },
    fallbackRect: {
      xPercent: typeof fallbackRectRecord.xPercent === 'number' ? fallbackRectRecord.xPercent : 0,
      yPercent: typeof fallbackRectRecord.yPercent === 'number' ? fallbackRectRecord.yPercent : 0,
      widthPercent: typeof fallbackRectRecord.widthPercent === 'number' ? fallbackRectRecord.widthPercent : 0,
      heightPercent: typeof fallbackRectRecord.heightPercent === 'number' ? fallbackRectRecord.heightPercent : 0,
    },
    markdown: typeof record.markdown === 'string' ? record.markdown : '',
    richTextHtml: typeof record.richTextHtml === 'string' ? record.richTextHtml : undefined,
    versions: versions.length > 0 ? versions : undefined,
    createdAt: typeof record.createdAt === 'string' ? record.createdAt : nowIso(),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : nowIso(),
  };
}

function getAnnotationVersions(annotation: AnnotationRecord): AnnotationVersion[] {
  if (annotation.versions && annotation.versions.length > 0) {
    return annotation.versions;
  }
  return [{
    id: `${annotation.id}-initial`,
    label: '初始版本',
    markdown: annotation.markdown,
    richTextHtml: annotation.richTextHtml,
    adjustmentNote: '',
    adjustmentDate: annotation.createdAt.slice(0, 10),
    author: '',
    createdAt: annotation.createdAt,
    updatedAt: annotation.updatedAt,
  }];
}

function getAnnotationVersion(annotation: AnnotationRecord, versionId?: string | null) {
  const versions = getAnnotationVersions(annotation);
  return versions.find((version) => version.id === versionId) || versions[versions.length - 1];
}

function syncAnnotationVersions(annotation: AnnotationRecord, versions: AnnotationVersion[]): AnnotationRecord {
  const latestVersion = versions[versions.length - 1];
  return {
    ...annotation,
    markdown: latestVersion.markdown,
    richTextHtml: latestVersion.richTextHtml,
    versions,
    updatedAt: nowIso(),
  };
}

function normalizeAnnotationLayerDocument(
  raw: unknown,
  explicitVersionOverviews?: unknown[],
  explicitAnnotations?: unknown[],
): AnnotationLayerDocument {
  const record = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const prototypeId = typeof record.prototypeId === 'string' && record.prototypeId.trim() ? record.prototypeId : PROTOTYPE_ID;
  const legacyVersionOverviews = Array.isArray(record.versionOverviews) ? record.versionOverviews : [];
  const overviewSources = explicitVersionOverviews || [...importedVersionOverviewSources, ...legacyVersionOverviews];
  const normalizedOverviews = overviewSources
    .map((item, index) => normalizeVersionOverview(item, index))
    .filter((overview, index, overviews) => overviews.findIndex((candidate) => candidate.id === overview.id) === index)
    .sort((left, right) => {
      const leftTime = new Date(left.createdAt).getTime();
      const rightTime = new Date(right.createdAt).getTime();
      return leftTime - rightTime || left.id.localeCompare(right.id);
    });
  const legacyAnnotations = Array.isArray(record.annotations) ? record.annotations : [];
  const annotationSources = explicitAnnotations || [...importedAnnotationSources, ...legacyAnnotations];
  const normalizedAnnotations = annotationSources
    .map((item, index) => normalizeAnnotationRecord(item, index, prototypeId))
    .filter((annotation, index, annotations) => annotations.findIndex((candidate) => (
      candidate.ownerId === annotation.ownerId && candidate.id === annotation.id
    )) === index);
  return {
    schemaVersion: 1,
    kind: 'prototype-annotation-layer',
    prototypeId,
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : nowIso(),
    versionOverviews: normalizedOverviews,
    annotations: normalizedAnnotations,
  };
}

function getPageAnnotations(document: AnnotationLayerDocument, pageId: string) {
  return document.annotations
    .filter((record) => record.pageId === pageId)
    .sort((left, right) => {
      const leftTime = new Date(left.createdAt).getTime();
      const rightTime = new Date(right.createdAt).getTime();
      return leftTime - rightTime || left.id.localeCompare(right.id);
    });
}

function resolveAnnotationBox(
  root: HTMLElement,
  annotation: AnnotationRecord,
  workspaceRect: RectLike,
): { rect: RectLike; usedFallback: boolean } {
  const selectorCandidates = annotation.locator.selectors.length > 0 ? annotation.locator.selectors : [];

  for (const selector of selectorCandidates) {
    const element = getDocumentRoot()?.querySelector(selector);
    if (!isHTMLElement(element) || !root.contains(element) || !isElementVisible(element)) {
      continue;
    }
    const rect = element.getBoundingClientRect();
    return {
      rect: normalizeRect(rect),
      usedFallback: false,
    };
  }

  if (annotation.locator.path.length > 0) {
    const element = getElementFromPath(root, annotation.locator.path);
    if (element && root.contains(element) && isElementVisible(element)) {
      const rect = element.getBoundingClientRect();
      return {
        rect: normalizeRect(rect),
        usedFallback: false,
      };
    }
  }

  return {
    rect: resolveFallbackRect(annotation.fallbackRect, workspaceRect),
    usedFallback: true,
  };
}

function pickBestSelectionTarget(root: HTMLElement, selection: RectLike) {
  const candidates = Array.from(root.querySelectorAll<HTMLElement>('*'))
    .filter((element) => element !== root && isSelectableElement(element));

  const scoredCandidates = candidates
    .map((element) => ({
      element,
      score: scoreSelectableElement(element, selection),
    }))
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((left, right) => right.score - left.score);

  for (const candidate of scoredCandidates) {
    if (candidate.score < 2.8 || !shouldUseElementTarget(candidate.element, selection)) {
      continue;
    }

    const rect = candidate.element.getBoundingClientRect();
    return {
      element: candidate.element,
      rect: normalizeRect(rect),
      selectors: buildCssSelector(root, candidate.element),
      path: getElementPath(root, candidate.element),
      fingerprint: getElementFingerprint(candidate.element),
    };
  }

  return null;
}

function useWorkspaceRect(selector: string, pageId: string) {
  const [workspaceRect, setWorkspaceRect] = useState<RectLike | null>(null);

  const refresh = useCallback(() => {
    const root = getWorkspaceRoot(selector);
    if (!root) {
      setWorkspaceRect(null);
      return;
    }
    setWorkspaceRect(normalizeRect(root.getBoundingClientRect()));
  }, [selector]);

  useEffect(() => {
    refresh();
    const onResize = () => refresh();
    const onScroll = () => refresh();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);

    const root = getWorkspaceRoot(selector);
    const observer = root && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => refresh()) : null;
    if (root && observer) {
      observer.observe(root);
    }

    const interval = window.setInterval(refresh, 600);

    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
      observer?.disconnect();
      window.clearInterval(interval);
    };
  }, [pageId, refresh, selector]);

  return { workspaceRect, refresh };
}

function usePrototypeAnnotationToast() {
  return useCallback((kind: 'success' | 'warning' | 'info' | 'error', text: string) => {
    const doc = getDocumentRoot();
    if (!doc) {
      return;
    }

    const containerId = 'prototype-annotation-toast-root';
    let container = doc.getElementById(containerId);
    if (!container) {
      container = doc.createElement('div');
      container.id = containerId;
      container.className = 'prototype-annotation-toast-root';
      doc.body.appendChild(container);
    }

    const toast = doc.createElement('div');
    toast.className = `prototype-annotation-toast prototype-annotation-toast--${kind}`;
    toast.textContent = text;
    container.appendChild(toast);
    window.setTimeout(() => {
      toast.classList.add('prototype-annotation-toast--leaving');
      window.setTimeout(() => toast.remove(), 180);
    }, 2400);
  }, []);
}

export default function PrototypeAnnotationLayer({
  currentPageId,
  currentPageTitle,
  workspaceSelector = DEFAULT_WORKSPACE_SELECTOR,
  prototypeId = PROTOTYPE_ID,
}: PrototypeAnnotationLayerProps) {
  const toast = usePrototypeAnnotationToast();
  const [documentState, setDocumentState] = useState<AnnotationLayerDocument>(() =>
    normalizeAnnotationLayerDocument(annotationLayerDocument)
  );
  const persistedAnnotationsRef = useRef<AnnotationRecord[]>(documentState.annotations.map((annotation) => ({ ...annotation })));
  const [annotationOwnerId, setAnnotationOwnerId] = useState(getInitialAnnotationOwnerId);
  const [mode, setMode] = useState<AnnotationLayerMode>('closed');
  const [tool, setTool] = useState<AnnotationLayerTool>('idle');
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [expandedAnnotationId, setExpandedAnnotationId] = useState<string | null>(null);
  const [editingVersionId, setEditingVersionId] = useState<string | null>(null);
  const [viewVersionIds, setViewVersionIds] = useState<Record<string, string>>({});
  const [versionSearchQuery, setVersionSearchQuery] = useState('');
  const [draftVersions, setDraftVersions] = useState<Record<string, AnnotationVersion>>({});
  const [dragSelection, setDragSelection] = useState<DragSelection | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [hasPendingChanges, setHasPendingChanges] = useState(false);
  const [toolbarPosition, setToolbarPosition] = useState<ToolbarPosition | null>(null);
  const [panelWidth, setPanelWidth] = useState<number | null>(null);
  const [isVersionOverviewOpen, setIsVersionOverviewOpen] = useState(false);
  const [isOverviewEditing, setIsOverviewEditing] = useState(false);
  const [overviewDrafts, setOverviewDrafts] = useState<VersionOverview[]>([]);
  const [selectedOverviewId, setSelectedOverviewId] = useState<string | null>(null);
  const [hasOverviewChanges, setHasOverviewChanges] = useState(false);
  const [isOverviewSaving, setIsOverviewSaving] = useState(false);
  const dragPointerIdRef = useRef<number | null>(null);
  const dragSelectionRef = useRef<DragSelection | null>(null);
  const mouseDragActiveRef = useRef(false);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const toolbarDragRef = useRef<ToolbarDrag | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const panelResizeRef = useRef<PanelResize | null>(null);
  const annotationCardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const { workspaceRect, refresh: refreshWorkspaceRect } = useWorkspaceRect(workspaceSelector, currentPageId);

  useEffect(() => {
    setSelectedAnnotationId(null);
    setExpandedAnnotationId(null);
    setEditingVersionId(null);
    setVersionSearchQuery('');
    setViewVersionIds({});
  }, [currentPageId]);

  useEffect(() => {
    if (!selectedAnnotationId) {
      return;
    }
    const selected = documentState.annotations.find((item) => item.id === selectedAnnotationId);
    if (!selected || selected.pageId !== currentPageId) {
      setSelectedAnnotationId(null);
    }
  }, [currentPageId, documentState.annotations, selectedAnnotationId]);

  useEffect(() => {
    if (mode !== 'edit' || !selectedAnnotationId) {
      return;
    }
    const selected = documentState.annotations.find((item) => item.id === selectedAnnotationId);
    if (!selected || selected.ownerId !== annotationOwnerId) {
      setSelectedAnnotationId(null);
      setEditingVersionId(null);
    }
  }, [annotationOwnerId, documentState.annotations, mode, selectedAnnotationId]);

  useEffect(() => {
    dragSelectionRef.current = dragSelection;
  }, [dragSelection]);

  useEffect(() => {
    if (mode !== 'view' || !selectedAnnotationId || expandedAnnotationId) {
      return;
    }
    annotationCardRefs.current.get(selectedAnnotationId)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [expandedAnnotationId, mode, selectedAnnotationId]);

  useEffect(() => {
    if (mode !== 'view') {
      setExpandedAnnotationId(null);
    }
  }, [mode]);

  useEffect(() => {
    const keepToolbarInViewport = () => {
      if (!toolbarPosition || !toolbarRef.current) {
        return;
      }
      const rect = toolbarRef.current.getBoundingClientRect();
      setToolbarPosition({
        left: clampNumber(toolbarPosition.left, 8, Math.max(8, window.innerWidth - rect.width - 8)),
        top: clampNumber(toolbarPosition.top, 4, Math.max(4, window.innerHeight - rect.height - 8)),
      });
    };

    keepToolbarInViewport();
    window.addEventListener('resize', keepToolbarInViewport);
    return () => window.removeEventListener('resize', keepToolbarInViewport);
  }, [mode, toolbarPosition?.left, toolbarPosition?.top]);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const drag = toolbarDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId || !toolbarRef.current) {
        return;
      }
      const rect = toolbarRef.current.getBoundingClientRect();
      setToolbarPosition({
        left: clampNumber(drag.left + event.clientX - drag.startX, 8, Math.max(8, window.innerWidth - rect.width - 8)),
        top: clampNumber(drag.top + event.clientY - drag.startY, 4, Math.max(4, window.innerHeight - rect.height - 8)),
      });
    };
    const handlePointerUp = (event: PointerEvent) => {
      if (toolbarDragRef.current?.pointerId === event.pointerId) {
        toolbarDragRef.current = null;
      }
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, []);

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const resize = panelResizeRef.current;
      if (!resize || resize.pointerId !== event.pointerId) {
        return;
      }
      setPanelWidth(clampNumber(
        resize.startWidth + resize.startX - event.clientX,
        MIN_PANEL_WIDTH,
        getPanelWidthLimit(),
      ));
    };
    const handlePointerUp = (event: PointerEvent) => {
      if (panelResizeRef.current?.pointerId === event.pointerId) {
        panelResizeRef.current = null;
      }
    };
    const handleResize = () => {
      setPanelWidth((currentWidth) => currentWidth === null
        ? null
        : clampNumber(currentWidth, MIN_PANEL_WIDTH, getPanelWidthLimit()));
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);
    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
      window.removeEventListener('resize', handleResize);
    };
  }, []);

  useEffect(() => {
    if (mode === 'edit') {
      return;
    }

    setTool('idle');
    setDragSelection(null);
    dragSelectionRef.current = null;
    dragPointerIdRef.current = null;
    mouseDragActiveRef.current = false;
  }, [mode]);

  const allPageAnnotations = useMemo(
    () => getPageAnnotations(documentState, currentPageId),
    [currentPageId, documentState]
  );
  const pageAnnotations = useMemo(
    () => mode === 'edit'
      ? allPageAnnotations.filter((annotation) => annotation.ownerId === annotationOwnerId)
      : allPageAnnotations,
    [allPageAnnotations, annotationOwnerId, mode]
  );
  const filteredViewAnnotations = useMemo(() => {
    if (mode !== 'view' || !versionSearchQuery.trim()) {
      return pageAnnotations;
    }
    return pageAnnotations.filter((annotation) => (
      getAnnotationVersions(annotation).some((version) => fuzzyMatchVersionLabel(version.label, versionSearchQuery))
    ));
  }, [mode, pageAnnotations, versionSearchQuery]);
  const selectedAnnotation = useMemo(
    () => pageAnnotations.find((item) => item.id === selectedAnnotationId) || null,
    [pageAnnotations, selectedAnnotationId]
  );
  const expandedAnnotation = useMemo(
    () => pageAnnotations.find((item) => item.id === expandedAnnotationId) || null,
    [expandedAnnotationId, pageAnnotations]
  );
  const selectedVersions = selectedAnnotation ? getAnnotationVersions(selectedAnnotation) : [];
  const selectedDraftVersion = selectedAnnotation ? draftVersions[selectedAnnotation.id] || null : null;
  const selectedVersion = selectedAnnotation
    ? (selectedDraftVersion?.id === editingVersionId
      ? selectedDraftVersion
      : getAnnotationVersion(selectedAnnotation, editingVersionId))
    : null;
  const expandedVersion = expandedAnnotation
    ? getAnnotationVersion(expandedAnnotation, viewVersionIds[expandedAnnotation.id])
    : null;
  const selectedOverview = overviewDrafts.find((overview) => overview.id === selectedOverviewId) || null;

  const renderedBoxes = useMemo<AnnotationLayerBox[]>(() => {
    if (!workspaceRect) {
      return [];
    }

    const root = getWorkspaceRoot(workspaceSelector);
    if (!root) {
      return [];
    }

    return pageAnnotations.map((record, index) => {
      const resolved = resolveAnnotationBox(root, record, workspaceRect);
      return {
        record,
        index: index + 1,
        rect: resolved.rect,
        usedFallback: resolved.usedFallback,
      };
    });
  }, [currentPageId, pageAnnotations, workspaceRect, workspaceSelector]);

  const selectionRect = useMemo<RectLike | null>(() => {
    if (!dragSelection) {
      return null;
    }

    const left = Math.min(dragSelection.startX, dragSelection.currentX);
    const top = Math.min(dragSelection.startY, dragSelection.currentY);
    const width = Math.abs(dragSelection.currentX - dragSelection.startX);
    const height = Math.abs(dragSelection.currentY - dragSelection.startY);
    return { left, top, width, height };
  }, [dragSelection]);

  const selectedCountLabel = `${pageAnnotations.length} 个`;
  const selectedAnnotationIndex = selectedAnnotation
    ? pageAnnotations.findIndex((item) => item.id === selectedAnnotation.id) + 1
    : 0;
  const expandedAnnotationIndex = expandedAnnotation
    ? pageAnnotations.findIndex((item) => item.id === expandedAnnotation.id) + 1
    : 0;
  const panelVisible = mode !== 'closed';

  useEffect(() => {
    const root = getDocumentRoot()?.querySelector('.plan-platform');
    if (!isHTMLElement(root)) {
      return;
    }

    root.classList.toggle('plan-platform--annotation-split', panelVisible);
    if (panelWidth !== null) {
      root.style.setProperty('--prototype-annotation-panel-width', `${panelWidth}px`);
    }
    const frameId = window.requestAnimationFrame(refreshWorkspaceRect);

    return () => {
      window.cancelAnimationFrame(frameId);
      root.classList.remove('plan-platform--annotation-split');
      root.style.removeProperty('--prototype-annotation-panel-width');
    };
  }, [panelVisible, panelWidth, refreshWorkspaceRect]);

  function markDirty(nextDocument: AnnotationLayerDocument) {
    setDocumentState(nextDocument);
    setHasPendingChanges(true);
    refreshWorkspaceRect();
  }

  function updateSelectedAnnotation(updater: (record: AnnotationRecord) => AnnotationRecord) {
    if (!selectedAnnotation || selectedAnnotation.ownerId !== annotationOwnerId) {
      return;
    }

    markDirty({
      ...documentState,
      updatedAt: nowIso(),
      annotations: documentState.annotations.map((record) => (record.id === selectedAnnotation.id ? updater(record) : record)),
    });
  }

  function updateSelectedVersion(updater: (version: AnnotationVersion) => AnnotationVersion) {
    if (!selectedAnnotation || !selectedVersion) {
      return;
    }
    if (selectedDraftVersion?.id === selectedVersion.id) {
      setDraftVersions((current) => ({
        ...current,
        [selectedAnnotation.id]: updater(current[selectedAnnotation.id]),
      }));
      setHasPendingChanges(true);
      return;
    }
    updateSelectedAnnotation((record) => {
      const versions = getAnnotationVersions(record).map((version) => (
        version.id === selectedVersion.id ? updater(version) : version
      ));
      return syncAnnotationVersions(record, versions);
    });
  }

  function configureAnnotationOwner() {
    if (hasPendingChanges) {
      toast('warning', '请先保存当前标注修改，再切换标注人。');
      return;
    }
    const enteredOwnerId = window.prompt(
      '请输入当前标注人标识（小写字母、数字或连字符，例如 zhangsan）：',
      annotationOwnerId,
    );
    if (enteredOwnerId === null) {
      return;
    }
    const nextOwnerId = normalizeAnnotationOwnerId(enteredOwnerId);
    if (!isSafeAnnotationOwnerId(nextOwnerId)) {
      toast('error', '标注人标识需以字母或数字开头，仅包含小写字母、数字和连字符，最长 32 位。');
      return;
    }
    try {
      window.localStorage.setItem(ANNOTATION_OWNER_STORAGE_KEY, nextOwnerId);
    } catch {
      // The current session still uses the selected owner when persistent browser storage is unavailable.
    }
    setAnnotationOwnerId(nextOwnerId);
    setSelectedAnnotationId(null);
    setEditingVersionId(null);
    toast('success', `当前标注人已切换为 ${nextOwnerId}。`);
  }

  function addAdjustmentVersion() {
    if (!selectedAnnotation) {
      return;
    }
    const existingDraft = draftVersions[selectedAnnotation.id];
    if (existingDraft) {
      setEditingVersionId(existingDraft.id);
      toast('info', '当前调整版本尚未保存。');
      return;
    }
    const versions = getAnnotationVersions(selectedAnnotation);
    const sourceVersion = versions[versions.length - 1];
    const createdAt = nowIso();
    const adjustmentDate = todayDateInput();
    const newVersion: AnnotationVersion = {
      ...sourceVersion,
      id: `${selectedAnnotation.id}-version-${Date.now()}`,
      label: formatAdjustmentVersionLabel(adjustmentDate),
      adjustmentDate,
      author: '',
      createdAt,
      updatedAt: createdAt,
    };
    setDraftVersions((current) => ({ ...current, [selectedAnnotation.id]: newVersion }));
    setHasPendingChanges(true);
    setEditingVersionId(newVersion.id);
    toast('info', '已创建待保存调整，保存后生成版本标签。');
  }

  function deleteAdjustmentVersion(versionId: string) {
    if (!selectedAnnotation) {
      return;
    }
    const versions = getAnnotationVersions(selectedAnnotation);
    const versionIndex = versions.findIndex((version) => version.id === versionId);
    if (versionIndex <= 0) {
      return;
    }
    const version = versions[versionIndex];
    if (!window.confirm(`确定删除调整版本“${version.label}”吗？删除后需保存才会生效。`)) {
      return;
    }

    const nextVersions = versions.filter((item) => item.id !== versionId);
    updateSelectedAnnotation((record) => syncAnnotationVersions(record, nextVersions));
    if (editingVersionId === versionId) {
      setEditingVersionId(nextVersions[nextVersions.length - 1].id);
    }
    setViewVersionIds((current) => {
      const next = { ...current };
      for (const [annotationId, selectedVersionId] of Object.entries(next)) {
        if (selectedVersionId === versionId) {
          delete next[annotationId];
        }
      }
      return next;
    });
    toast('warning', '已删除调整版本，记得保存。');
  }

  function handleToolbarPointerDown(event: React.PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || !toolbarRef.current) {
      return;
    }
    const rect = toolbarRef.current.getBoundingClientRect();
    toolbarDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      left: rect.left,
      top: rect.top,
    };
    event.preventDefault();
  }

  function handlePanelResizePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (event.button !== 0 || !panelRef.current) {
      return;
    }
    panelResizeRef.current = {
      pointerId: event.pointerId,
      startWidth: panelRef.current.getBoundingClientRect().width,
      startX: event.clientX,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function resizePanelBy(delta: number) {
    const currentWidth = panelRef.current?.getBoundingClientRect().width || MIN_PANEL_WIDTH;
    setPanelWidth(clampNumber(currentWidth + delta, MIN_PANEL_WIDTH, getPanelWidthLimit()));
  }

  function openVersionOverview() {
    const drafts = documentState.versionOverviews.map((overview) => ({ ...overview }));
    setOverviewDrafts(drafts);
    setSelectedOverviewId(drafts[drafts.length - 1]?.id || null);
    setHasOverviewChanges(false);
    setIsOverviewEditing(false);
    setIsVersionOverviewOpen(true);
  }

  function closeVersionOverview() {
    if (hasOverviewChanges && !window.confirm('版本概览还有未保存的内容，确定关闭吗？')) {
      return;
    }
    setIsVersionOverviewOpen(false);
    setOverviewDrafts([]);
    setSelectedOverviewId(null);
    setHasOverviewChanges(false);
    setIsOverviewEditing(false);
  }

  function startVersionOverviewEditing() {
    if (!ENABLE_EDITING) {
      return;
    }
    setIsOverviewEditing(true);
  }

  function cancelVersionOverviewEditing() {
    if (hasOverviewChanges && !window.confirm('版本概览还有未保存的内容，确定取消编辑吗？')) {
      return;
    }
    const drafts = documentState.versionOverviews.map((overview) => ({ ...overview }));
    const currentSelectionExists = drafts.some((overview) => overview.id === selectedOverviewId);
    setOverviewDrafts(drafts);
    setSelectedOverviewId(currentSelectionExists ? selectedOverviewId : drafts[drafts.length - 1]?.id || null);
    setHasOverviewChanges(false);
    setIsOverviewEditing(false);
  }

  function addVersionOverview() {
    if (!ENABLE_EDITING || !isOverviewEditing) {
      return;
    }
    const createdAt = nowIso();
    const overview: VersionOverview = {
      id: `version-overview-${Date.now()}`,
      label: '',
      markdown: '',
      richTextHtml: '',
      createdAt,
      updatedAt: createdAt,
    };
    setOverviewDrafts((current) => [...current, overview]);
    setSelectedOverviewId(overview.id);
    setHasOverviewChanges(true);
  }

  function updateSelectedOverview(updater: (overview: VersionOverview) => VersionOverview) {
    if (!selectedOverview) {
      return;
    }
    setOverviewDrafts((current) => current.map((overview) => (
      overview.id === selectedOverview.id ? updater(overview) : overview
    )));
    setHasOverviewChanges(true);
  }

  function createAnnotationFromSelection(rect: RectLike) {
    const root = getWorkspaceRoot(workspaceSelector);
    if (!root || !workspaceRect) {
      toast('warning', '当前页面还没有可用的工作区。');
      return;
    }

    const target = pickBestSelectionTarget(root, rect);
    const selectedRect = target?.rect || rect;
    const now = nowIso();
    const nextIndex = pageAnnotations.length + 1;
    const record: AnnotationRecord = {
      id: `annotation-${annotationOwnerId}-${currentPageId}-${Date.now()}`,
      ownerId: annotationOwnerId,
      pageId: currentPageId,
      title: `模块标注 ${nextIndex}`,
      locator: target
        ? {
            selectors: target.selectors,
            path: target.path,
            fingerprint: target.fingerprint,
          }
        : {
            selectors: [],
            path: [],
            fingerprint: `fallback:${currentPageId}:${now}`,
          },
      fallbackRect: createFallbackRect(selectedRect, workspaceRect),
      markdown: '',
      createdAt: now,
      updatedAt: now,
    };

    markDirty({
      ...documentState,
      updatedAt: now,
      annotations: [...documentState.annotations, record],
    });
    setSelectedAnnotationId(record.id);
    setEditingVersionId(`${record.id}-initial`);
    setMode('edit');
    setTool('idle');
    toast('success', '已新增标注。');
  }

  async function persistAnnotationChanges(
    annotations: AnnotationRecord[],
    deletedAnnotationIds: string[],
  ) {
    if (annotations.length === 0 && deletedAnnotationIds.length === 0) {
      return;
    }
    const requestBody = JSON.stringify({
      prototypeId,
      ownerId: annotationOwnerId,
      annotations,
      deletedAnnotationIds,
    });
    if (new Blob([requestBody]).size > MAX_SAVE_PAYLOAD_BYTES) {
      throw new Error('标注内容超过 25 MB，请删除或压缩部分图片后再保存。');
    }
    const response = await fetch(ANNOTATION_SAVE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody,
    });

    const payload = (await response.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.message || '保存失败。');
    }
  }

  async function persistVersionOverviews(versionOverviews: VersionOverview[]) {
    if (versionOverviews.length === 0) {
      return;
    }
    const requestBody = JSON.stringify({ prototypeId, versionOverviews });
    if (new Blob([requestBody]).size > MAX_SAVE_PAYLOAD_BYTES) {
      throw new Error('版本说明超过 25 MB，请删除或压缩部分图片后再保存。');
    }
    const response = await fetch(VERSION_OVERVIEW_SAVE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: requestBody,
    });

    const payload = (await response.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
    if (!response.ok || !payload?.ok) {
      throw new Error(payload?.message || '版本概览保存失败。');
    }
  }

  async function handleSave() {
    if (!ENABLE_EDITING) {
      return;
    }
    if (!hasPendingChanges) {
      toast('info', '当前没有需要保存的变更。');
      return;
    }

    setIsSaving(true);
    try {
      const documentWithDrafts: AnnotationLayerDocument = {
        ...documentState,
        annotations: documentState.annotations.map((annotation) => {
          const draftVersion = draftVersions[annotation.id];
          return draftVersion
            ? syncAnnotationVersions(annotation, [...getAnnotationVersions(annotation), draftVersion])
            : annotation;
        }),
      };
      const incompleteVersion = documentWithDrafts.annotations
        .filter((annotation) => annotation.ownerId === annotationOwnerId)
        .flatMap((annotation) => (
        annotation.versions?.slice(1).map((version) => ({ annotation, version })) || []
      )).find(({ version }) => (
        !version.adjustmentDate.trim() || !version.author.trim() || !version.adjustmentNote.trim()
      ));
      if (incompleteVersion) {
        const missingFields = [
          !incompleteVersion.version.adjustmentDate.trim() ? '调整日期' : '',
          !incompleteVersion.version.author.trim() ? '作者' : '',
          !incompleteVersion.version.adjustmentNote.trim() ? '调整说明' : '',
        ].filter(Boolean).join('、');
        throw new Error(`${incompleteVersion.annotation.title} 的${incompleteVersion.version.label}需要填写${missingFields}。`);
      }
      const persistedAnnotations = persistedAnnotationsRef.current;
      const persistedById = new Map(
        persistedAnnotations
          .filter((annotation) => annotation.ownerId === annotationOwnerId)
          .map((annotation) => [annotation.id, annotation])
      );
      const ownedAnnotations = documentWithDrafts.annotations.filter(
        (annotation) => annotation.ownerId === annotationOwnerId
      );
      const currentOwnedIds = new Set(ownedAnnotations.map((annotation) => annotation.id));
      const changedAnnotations = ownedAnnotations.filter((annotation) => {
        const persistedAnnotation = persistedById.get(annotation.id);
        return !persistedAnnotation || JSON.stringify(persistedAnnotation) !== JSON.stringify(annotation);
      });
      const deletedAnnotationIds = persistedAnnotations
        .filter((annotation) => annotation.ownerId === annotationOwnerId && !currentOwnedIds.has(annotation.id))
        .map((annotation) => annotation.id);
      await persistAnnotationChanges(changedAnnotations, deletedAnnotationIds);
      persistedAnnotationsRef.current = documentWithDrafts.annotations.map((annotation) => ({ ...annotation }));
      setDocumentState(documentWithDrafts);
      setDraftVersions({});
      setHasPendingChanges(false);
      toast('success', `已保存 ${annotationOwnerId} 的原型标注。`);
    } catch (error) {
      toast('error', error instanceof Error ? error.message : '保存失败。');
    } finally {
      setIsSaving(false);
    }
  }

  async function handleSaveVersionOverviews() {
    if (!ENABLE_EDITING || !hasOverviewChanges) {
      return;
    }
    if (hasPendingChanges) {
      toast('warning', '请先保存当前标注调整，再保存版本概览。');
      return;
    }

    setIsOverviewSaving(true);
    try {
      const normalizedLabels = overviewDrafts.map((overview) => overview.label.trim());
      const missingLabelIndex = normalizedLabels.findIndex((label) => !label);
      if (missingLabelIndex >= 0) {
        setSelectedOverviewId(overviewDrafts[missingLabelIndex].id);
        throw new Error('请填写版本标识，例如 V1.0。');
      }
      const duplicateLabel = normalizedLabels.find((label, index) => (
        normalizedLabels.findIndex((candidate) => candidate.toLowerCase() === label.toLowerCase()) !== index
      ));
      if (duplicateLabel) {
        throw new Error(`版本标识“${duplicateLabel}”已存在。`);
      }

      const savedAt = nowIso();
      const savedOverviewById = new Map(documentState.versionOverviews.map((overview) => [overview.id, overview]));
      const savedOverviews = overviewDrafts.map((overview) => ({
        ...overview,
        label: overview.label.trim(),
        updatedAt: (() => {
          const savedOverview = savedOverviewById.get(overview.id);
          const hasContentChanged = !savedOverview
            || savedOverview.label !== overview.label.trim()
            || savedOverview.markdown !== overview.markdown
            || savedOverview.richTextHtml !== overview.richTextHtml;
          return hasContentChanged ? savedAt : savedOverview.updatedAt;
        })(),
      }));
      const changedOverviews = savedOverviews.filter((overview) => {
        const savedOverview = savedOverviewById.get(overview.id);
        return !savedOverview
          || savedOverview.label !== overview.label
          || savedOverview.markdown !== overview.markdown
          || savedOverview.richTextHtml !== overview.richTextHtml;
      });
      await persistVersionOverviews(changedOverviews);
      const savedDocument: AnnotationLayerDocument = {
        ...documentState,
        versionOverviews: savedOverviews,
      };
      setDocumentState(savedDocument);
      setOverviewDrafts(savedDocument.versionOverviews.map((overview) => ({ ...overview })));
      setHasOverviewChanges(false);
      setIsOverviewEditing(false);
      toast('success', '版本概览已保存。');
    } catch (error) {
      toast('error', error instanceof Error ? error.message : '版本概览保存失败。');
    } finally {
      setIsOverviewSaving(false);
    }
  }

  function handleDeleteSelectedAnnotation() {
    if (!selectedAnnotation) {
      return;
    }
    if (!window.confirm('删除这个标注吗？')) {
      return;
    }

    const nextAnnotations = documentState.annotations.filter((item) => item.id !== selectedAnnotation.id);
    setDraftVersions((current) => {
      const next = { ...current };
      delete next[selectedAnnotation.id];
      return next;
    });
    markDirty({
      ...documentState,
      updatedAt: nowIso(),
      annotations: nextAnnotations,
    });
    setSelectedAnnotationId(null);
    toast('warning', '已删除标注，记得保存。');
  }

  function closeAnnotationLayer() {
    setMode('closed');
    setTool('idle');
    setSelectedAnnotationId(null);
    setExpandedAnnotationId(null);
    setEditingVersionId(null);
    setVersionSearchQuery('');
    setViewVersionIds({});
    dragPointerIdRef.current = null;
    dragSelectionRef.current = null;
    mouseDragActiveRef.current = false;
    setDragSelection(null);
  }

  function openAnnotationViewer() {
    setTool('idle');
    setExpandedAnnotationId(null);
    setVersionSearchQuery('');
    setViewVersionIds({});
    setMode('view');
  }

  function handleAnnotationClick(annotationId: string) {
    setSelectedAnnotationId(annotationId);
    if (mode === 'edit') {
      const annotation = pageAnnotations.find((item) => item.id === annotationId);
      setEditingVersionId(draftVersions[annotationId]?.id || (annotation ? getAnnotationVersion(annotation).id : null));
    }
    if (mode === 'view' && expandedAnnotationId) {
      setExpandedAnnotationId(annotationId);
    }
    setMode(mode === 'closed' ? 'view' : mode);
  }

  function beginDragSelection(clientX: number, clientY: number): boolean {
    if (tool !== 'select' || mode !== 'edit') {
      return false;
    }

    const root = getWorkspaceRoot(workspaceSelector);
    if (!root || !workspaceRect) {
      return false;
    }

    const selectionPoint = { x: clientX, y: clientY };
    if (
      selectionPoint.x < workspaceRect.left ||
      selectionPoint.x > workspaceRect.left + workspaceRect.width ||
      selectionPoint.y < workspaceRect.top ||
      selectionPoint.y > workspaceRect.top + workspaceRect.height
    ) {
      return false;
    }

    const nextSelection = {
      startX: clientX,
      startY: clientY,
      currentX: clientX,
      currentY: clientY,
    };
    dragSelectionRef.current = nextSelection;
    setDragSelection(nextSelection);
    setSelectedAnnotationId(null);
    return true;
  }

  function updateDragSelection(clientX: number, clientY: number) {
    if (tool !== 'select' || mode !== 'edit' || !dragSelectionRef.current) {
      return;
    }

    const nextSelection = { ...dragSelectionRef.current, currentX: clientX, currentY: clientY };
    dragSelectionRef.current = nextSelection;
    setDragSelection(nextSelection);
  }

  function completeDragSelection() {
    const currentSelection = dragSelectionRef.current;
    dragSelectionRef.current = null;
    mouseDragActiveRef.current = false;
    setDragSelection(null);
    if (!currentSelection) {
      return;
    }

    const left = Math.min(currentSelection.startX, currentSelection.currentX);
    const top = Math.min(currentSelection.startY, currentSelection.currentY);
    const width = Math.abs(currentSelection.currentX - currentSelection.startX);
    const height = Math.abs(currentSelection.currentY - currentSelection.startY);

    if (width < 8 || height < 8) {
      toast('warning', '请拖拽形成一个足够大的框选区域。');
      return;
    }

    createAnnotationFromSelection({ left, top, width, height });
  }

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    if (!beginDragSelection(event.clientX, event.clientY)) {
      return;
    }

    dragPointerIdRef.current = event.pointerId;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic or browser-generated mouse fallback events may not have capturable pointer state.
    }
    event.preventDefault();
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (dragPointerIdRef.current !== event.pointerId) {
      return;
    }

    updateDragSelection(event.clientX, event.clientY);
  }

  function finishPointerSelection(event: React.PointerEvent<HTMLDivElement>) {
    if (dragPointerIdRef.current !== event.pointerId) {
      return;
    }

    dragPointerIdRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Ignore pointer capture release issues.
    }

    completeDragSelection();
  }

  function handleMouseDown(event: React.MouseEvent<HTMLDivElement>) {
    if (event.button !== 0 || dragPointerIdRef.current !== null || !beginDragSelection(event.clientX, event.clientY)) {
      return;
    }

    mouseDragActiveRef.current = true;
    event.preventDefault();
  }

  function handleMouseMove(event: React.MouseEvent<HTMLDivElement>) {
    if (!mouseDragActiveRef.current || dragPointerIdRef.current !== null) {
      return;
    }

    updateDragSelection(event.clientX, event.clientY);
  }

  function finishMouseSelection() {
    if (!mouseDragActiveRef.current || dragPointerIdRef.current !== null) {
      return;
    }

    completeDragSelection();
  }

  function renderPanelContent() {
    if (mode === 'view') {
      if (expandedAnnotation) {
        const currentIndex = expandedAnnotationIndex || 1;
        const versions = getAnnotationVersions(expandedAnnotation);
        return (
          <div className="prototype-annotation-panel__body prototype-annotation-panel__body--detail">
            <div className="prototype-annotation-panel__field">
              <span>标题</span>
              <div className="prototype-annotation-panel__readonly-value">
                {expandedAnnotation.title || `标注 ${currentIndex}`}
              </div>
            </div>

            <div className="prototype-annotation-panel__version-tabs" role="tablist" aria-label="标注版本">
              {versions.map((version) => (
                <button
                  aria-selected={version.id === expandedVersion?.id}
                  className={version.id === expandedVersion?.id ? 'is-active' : ''}
                  key={version.id}
                  onClick={() => setViewVersionIds((current) => ({ ...current, [expandedAnnotation.id]: version.id }))}
                  role="tab"
                  type="button"
                >
                  {version.label}
                </button>
              ))}
            </div>

            <div className="prototype-annotation-panel__rich-text-field">
              <span>标注内容</span>
              <div className="prototype-annotation-panel__view-content">
                <AnnotationMarkdownViewer
                  content={expandedVersion?.markdown || '暂无说明'}
                  html={expandedVersion?.richTextHtml}
                />
              </div>
            </div>

            {expandedVersion && expandedVersion.label !== '初始版本' && (
              <div className="prototype-annotation-panel__adjustment-summary">
                <div className="prototype-annotation-panel__adjustment-meta">
                  <span>调整日期：{expandedVersion.adjustmentDate || '未填写'}</span>
                  <span>作者：{expandedVersion.author || '未填写'}</span>
                </div>
                <div className="prototype-annotation-panel__adjustment-note">
                  <strong>调整说明</strong>
                  <p>{expandedVersion.adjustmentNote || '暂无调整说明'}</p>
                </div>
              </div>
            )}

            <div className="prototype-annotation-panel__meta">
              <span>页面：{currentPageTitle}</span>
              <span>序号：{currentIndex}</span>
              <span>标注人：{expandedAnnotation.ownerId}</span>
              <span>仅查看</span>
            </div>
          </div>
        );
      }

      if (pageAnnotations.length === 0) {
        return (
          <div className="prototype-annotation-panel__empty">
            <span>当前页暂无标注</span>
          </div>
        );
      }

      return (
        <div className="prototype-annotation-panel__body prototype-annotation-panel__body--view">
          <div className="prototype-annotation-panel__version-search">
            <div className="prototype-annotation-panel__version-search-control">
              <Search size={15} aria-hidden />
              <input
                aria-label="搜索标注版本"
                onChange={(event) => {
                  setVersionSearchQuery(event.target.value);
                  setSelectedAnnotationId(null);
                }}
                placeholder="搜索版本，如 250917调整"
                type="search"
                value={versionSearchQuery}
              />
              {versionSearchQuery && (
                <button
                  aria-label="清空版本搜索"
                  onClick={() => {
                    setVersionSearchQuery('');
                    setSelectedAnnotationId(null);
                  }}
                  title="清空搜索"
                  type="button"
                >
                  <X size={13} aria-hidden />
                </button>
              )}
            </div>
            <span aria-live="polite">
              {versionSearchQuery.trim()
                ? `${filteredViewAnnotations.length} 条匹配`
                : `${pageAnnotations.length} 条标注`}
            </span>
          </div>

          {filteredViewAnnotations.length === 0 ? (
            <div className="prototype-annotation-panel__search-empty">
              <Search size={24} aria-hidden />
              <strong>未找到相关版本</strong>
              <span>请尝试输入其他版本名称字符</span>
            </div>
          ) : (
            <div className="prototype-annotation-panel__list" role="list" aria-label="当前页标注列表">
            {filteredViewAnnotations.map((annotation) => {
              const annotationIndex = pageAnnotations.findIndex((item) => item.id === annotation.id) + 1;
              const isSelected = annotation.id === selectedAnnotationId;
              const versions = getAnnotationVersions(annotation);
              const reversedVersions = [...versions].reverse();
              const visibleVersions = versionSearchQuery.trim()
                ? reversedVersions.filter((version) => fuzzyMatchVersionLabel(version.label, versionSearchQuery))
                : reversedVersions;
              const storedViewVersion = getAnnotationVersion(annotation, viewVersionIds[annotation.id]);
              const selectedViewVersion = visibleVersions.find((version) => version.id === storedViewVersion.id)
                || visibleVersions[0]
                || storedViewVersion;
              const recentVersions = visibleVersions.length > 2 ? visibleVersions.slice(0, 1) : visibleVersions;
              const historyVersions = visibleVersions.length > 2 ? visibleVersions.slice(1) : [];
              const isHistoryVersionSelected = historyVersions.some((version) => version.id === selectedViewVersion.id);
              return (
                <div
                  className={`prototype-annotation-card${isSelected ? ' is-selected' : ''}`}
                  data-annotation-card-id={annotation.id}
                  key={annotation.id}
                  onDoubleClick={() => {
                    setSelectedAnnotationId(annotation.id);
                    setViewVersionIds((current) => ({ ...current, [annotation.id]: selectedViewVersion.id }));
                    setExpandedAnnotationId(annotation.id);
                  }}
                  ref={(element) => {
                    if (element) {
                      annotationCardRefs.current.set(annotation.id, element);
                    } else {
                      annotationCardRefs.current.delete(annotation.id);
                    }
                  }}
                  role="listitem"
                >
                  <button
                    aria-label={`标注 ${annotationIndex}：${annotation.title}`}
                    aria-pressed={isSelected}
                    className="prototype-annotation-card__main"
                    onClick={() => {
                      setViewVersionIds((current) => ({ ...current, [annotation.id]: selectedViewVersion.id }));
                      handleAnnotationClick(annotation.id);
                    }}
                    type="button"
                  >
                    <div className="prototype-annotation-card__marker" aria-hidden>{annotationIndex}</div>
                    <div className="prototype-annotation-card__content">
                      <strong>{annotation.title || `标注 ${annotationIndex}`}</strong>
                      <AnnotationMarkdownViewer
                        content={selectedViewVersion.markdown || '暂无说明'}
                        html={selectedViewVersion.richTextHtml}
                      />
                    </div>
                  </button>
                  <div className="prototype-annotation-card__versions" aria-label="版本列表">
                    {recentVersions.map((version) => (
                      <button
                        aria-pressed={version.id === selectedViewVersion.id}
                        className={version.id === selectedViewVersion.id ? 'is-active' : ''}
                        key={version.id}
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelectedAnnotationId(annotation.id);
                          setViewVersionIds((current) => ({ ...current, [annotation.id]: version.id }));
                        }}
                        onDoubleClick={(event) => event.stopPropagation()}
                        type="button"
                      >
                        {version.label}
                      </button>
                    ))}
                    {historyVersions.length > 0 && (
                      <details
                        className={`prototype-annotation-card__history${isHistoryVersionSelected ? ' is-active' : ''}`}
                        onClick={(event) => event.stopPropagation()}
                        onDoubleClick={(event) => event.stopPropagation()}
                      >
                        <summary title={`查看其余 ${historyVersions.length} 个历史版本`}>
                          <History size={12} aria-hidden />
                          历史 {historyVersions.length}
                        </summary>
                        <div className="prototype-annotation-card__history-menu">
                          {historyVersions.map((version) => (
                            <button
                              aria-pressed={version.id === selectedViewVersion.id}
                              className={version.id === selectedViewVersion.id ? 'is-active' : ''}
                              key={version.id}
                              onClick={(event) => {
                                event.stopPropagation();
                                setSelectedAnnotationId(annotation.id);
                                setViewVersionIds((current) => ({ ...current, [annotation.id]: version.id }));
                                event.currentTarget.closest('details')?.removeAttribute('open');
                              }}
                              type="button"
                            >
                              {version.label}
                            </button>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                  {selectedViewVersion.label !== '初始版本' && (
                    <div className="prototype-annotation-card__adjustment">
                      <div>
                        <span>{selectedViewVersion.adjustmentDate || '未填写日期'}</span>
                        <span>{selectedViewVersion.author || '未填写作者'}</span>
                      </div>
                      <p>{selectedViewVersion.adjustmentNote || '暂无调整说明'}</p>
                    </div>
                  )}
                </div>
              );
            })}
            </div>
          )}
        </div>
      );
    }

    if (!selectedAnnotation) {
      return (
        <div className="prototype-annotation-panel__empty">
          <span>当前页：{selectedCountLabel}</span>
          <button
            className="prototype-annotation-panel__create"
            type="button"
            onClick={() => {
              setTool('select');
              toast('info', '开始框选一个模块。');
            }}
          >
            <Plus size={16} aria-hidden />
            新增框选
          </button>
        </div>
      );
    }

    const currentIndex = selectedAnnotationIndex || 1;
    const isEditingDraftVersion = Boolean(selectedVersion && selectedDraftVersion?.id === selectedVersion.id);
    const isEditingAdjustmentVersion = Boolean(
      selectedVersion && (
        isEditingDraftVersion ||
        selectedVersions.findIndex((version) => version.id === selectedVersion.id) > 0
      )
    );

    return (
      <div className="prototype-annotation-panel__body prototype-annotation-panel__body--editor">
        <label className="prototype-annotation-panel__field">
          <span>标题</span>
          <input
            value={selectedAnnotation.title}
            placeholder={`标注 ${currentIndex}`}
            onChange={(event) => {
              updateSelectedAnnotation((record) => ({
                ...record,
                title: event.target.value,
                updatedAt: nowIso(),
              }));
            }}
          />
        </label>

        <div className="prototype-annotation-panel__version-tabs" role="tablist" aria-label="标注版本">
          {selectedVersions.map((version, versionIndex) => (
            <div className="prototype-annotation-panel__version-tab-item" key={version.id}>
              <button
                aria-selected={version.id === selectedVersion?.id}
                className={version.id === selectedVersion?.id ? 'is-active' : ''}
                onClick={() => setEditingVersionId(version.id)}
                role="tab"
                type="button"
              >
                {version.label}
              </button>
              {versionIndex > 0 && (
                <button
                  aria-label={`删除调整版本 ${version.label}`}
                  className="prototype-annotation-panel__delete-version"
                  onClick={() => deleteAdjustmentVersion(version.id)}
                  title={`删除调整版本 ${version.label}`}
                  type="button"
                >
                  <Trash2 size={13} aria-hidden />
                </button>
              )}
            </div>
          ))}
          {selectedDraftVersion && (
            <div className="prototype-annotation-panel__version-tab-item prototype-annotation-panel__version-tab-item--draft">
              <button
                aria-selected={isEditingDraftVersion}
                className={isEditingDraftVersion ? 'is-active' : ''}
                onClick={() => setEditingVersionId(selectedDraftVersion.id)}
                role="tab"
                type="button"
              >
                <PencilLine size={12} aria-hidden />
                未保存调整
              </button>
            </div>
          )}
        </div>

        <div className="prototype-annotation-panel__rich-text-field">
          <div className="prototype-annotation-panel__field-heading">
            <span>标注内容</span>
            <button
              className="prototype-annotation-panel__add-version"
              disabled={Boolean(selectedDraftVersion)}
              title={selectedDraftVersion ? '请先保存当前调整版本' : '从最新版本复制并新增调整'}
              type="button"
              onClick={addAdjustmentVersion}
            >
              <Plus size={14} aria-hidden />
              {selectedDraftVersion ? '调整版本待保存' : '新增调整版本'}
            </button>
          </div>
          <AnnotationRichTextEditor
            value={selectedVersion?.richTextHtml !== undefined
              ? selectedVersion.richTextHtml
              : markdownToRichTextHtml(selectedVersion?.markdown || '')}
            onChange={(richTextHtml) => {
              updateSelectedVersion((version) => ({
                ...version,
                richTextHtml,
                updatedAt: nowIso(),
              }));
            }}
            onError={(message) => toast('error', message)}
          />
        </div>

        {selectedVersion && isEditingAdjustmentVersion && (
          <section className="prototype-annotation-panel__adjustment-form" aria-label="调整说明">
            <div className="prototype-annotation-panel__adjustment-form-title">
              <strong>调整说明</strong>
              {isEditingDraftVersion && <span>未保存</span>}
            </div>
            <div className="prototype-annotation-panel__adjustment-fields">
              <label>
                <span>调整日期 <i aria-hidden>*</i></span>
                <input
                  aria-required="true"
                  required
                  type="date"
                  value={selectedVersion.adjustmentDate}
                  onChange={(event) => {
                    const adjustmentDate = event.target.value;
                    updateSelectedVersion((version) => ({
                      ...version,
                      adjustmentDate,
                      label: formatAdjustmentVersionLabel(adjustmentDate),
                      updatedAt: nowIso(),
                    }));
                  }}
                />
              </label>
              <label>
                <span>作者 <i aria-hidden>*</i></span>
                <input
                  aria-required="true"
                  required
                  value={selectedVersion.author}
                  placeholder="请输入调整人"
                  onChange={(event) => updateSelectedVersion((version) => ({
                    ...version,
                    author: event.target.value,
                    updatedAt: nowIso(),
                  }))}
                />
              </label>
            </div>
            <label className="prototype-annotation-panel__adjustment-textarea">
              <span>说明内容 <i aria-hidden>*</i></span>
              <textarea
                aria-required="true"
                required
                value={selectedVersion.adjustmentNote}
                placeholder="说明本次原型调整内容"
                onChange={(event) => updateSelectedVersion((version) => ({
                  ...version,
                  adjustmentNote: event.target.value,
                  updatedAt: nowIso(),
                }))}
              />
            </label>
          </section>
        )}

        <div className="prototype-annotation-panel__meta">
          <span>页面：{currentPageTitle}</span>
          <span>序号：{currentIndex}</span>
          <span>标注人：{selectedAnnotation.ownerId}</span>
          <span>{selectedAnnotation.locator.selectors.length > 0 ? 'DOM 锚定' : '区域兜底'}</span>
        </div>
      </div>
    );
  }

  const canShowEditor = ENABLE_EDITING && mode === 'edit';
  const toolbarClassName = `prototype-annotation-toolbar prototype-annotation-toolbar--${mode}`;
  const pageAnnotationCountLabel = `本页共 ${pageAnnotations.length} 个标注`;

  return (
    <>
      <div
        className={toolbarClassName}
        ref={toolbarRef}
        style={toolbarPosition ? { left: `${toolbarPosition.left}px`, right: 'auto', top: `${toolbarPosition.top}px` } : undefined}
      >
        <button
          aria-label="拖动标注工具条"
          className="prototype-annotation-toolbar__drag-handle"
          onPointerDown={handleToolbarPointerDown}
          title="拖动调整位置"
          type="button"
        >
          <GripVertical size={15} aria-hidden />
        </button>
        <div className="prototype-annotation-toolbar__count" aria-live="polite" title={pageAnnotationCountLabel}>
          <span>本页共</span>
          <strong>{pageAnnotations.length}</strong>
          <span>个标注</span>
        </div>
        <button type="button" onClick={openVersionOverview}>
          <BookOpen size={16} aria-hidden />
          版本概览
        </button>

        {mode === 'closed' && (
          <>
            <button type="button" onClick={openAnnotationViewer}>
              <Eye size={16} aria-hidden />
              查看标注
            </button>
            {ENABLE_EDITING && (
              <button
                className="is-primary"
                type="button"
                onClick={() => {
                  setTool('idle');
                  setExpandedAnnotationId(null);
                  setMode('edit');
                }}
              >
                <PencilLine size={16} aria-hidden />
                编辑标注
              </button>
            )}
          </>
        )}

        {mode === 'view' && (
          <>
            <button type="button" onClick={closeAnnotationLayer}>
              <X size={16} aria-hidden />
              关闭标注
            </button>
            {ENABLE_EDITING && (
              <button
                className="is-primary"
                type="button"
                onClick={() => {
                  setTool('idle');
                  setExpandedAnnotationId(null);
                  setMode('edit');
                }}
              >
                <PencilLine size={16} aria-hidden />
                编辑标注
              </button>
            )}
          </>
        )}

        {mode === 'edit' && (
          <>
            <button type="button" onClick={closeAnnotationLayer}>
              <X size={16} aria-hidden />
              关闭标注
            </button>
            <button
              type="button"
              onClick={openAnnotationViewer}
            >
              <Eye size={16} aria-hidden />
              查看标注
            </button>
            {ENABLE_EDITING && (
              <>
                <button
                  className="prototype-annotation-toolbar__owner"
                  onClick={configureAnnotationOwner}
                  title="点击切换当前标注人"
                  type="button"
                >
                  <UserRound size={16} aria-hidden />
                  标注人：{annotationOwnerId}
                </button>
                <button className={tool === 'select' ? 'is-active' : ''} type="button" onClick={() => setTool('select')}>
                  <MousePointer2 size={16} aria-hidden />
                  新增框选
                </button>
                <button className="is-primary" disabled={isSaving || !hasPendingChanges} type="button" onClick={handleSave}>
                  <Save size={16} aria-hidden />
                  {isSaving ? '保存中' : '保存'}
                </button>
              </>
            )}
          </>
        )}
      </div>

      {mode !== 'closed' && (
        <div
          className={[
            'prototype-annotation-layer',
            mode === 'edit' && tool === 'select' ? 'is-selecting' : '',
          ].filter(Boolean).join(' ')}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={finishPointerSelection}
          onPointerCancel={finishPointerSelection}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={finishMouseSelection}
          onMouseLeave={finishMouseSelection}
        >
          {workspaceRect && selectionRect && mode === 'edit' && tool === 'select' && (
            <div
              className="prototype-annotation-layer__selection"
              style={{
                left: `${selectionRect.left}px`,
                top: `${selectionRect.top}px`,
                width: `${selectionRect.width}px`,
                height: `${selectionRect.height}px`,
              }}
            />
          )}

          {renderedBoxes.map((box) => {
            const isSelected = box.record.id === selectedAnnotation?.id;
            const labelLeft = Math.max(box.rect.left - 10, 12);
            const labelTop = Math.max(box.rect.top - 16, 46);
            return (
              <div
                className={[
                  'prototype-annotation-layer__box',
                  isSelected ? 'is-selected' : '',
                  box.usedFallback ? 'is-fallback' : '',
                ].filter(Boolean).join(' ')}
                key={box.record.id}
                style={{
                  left: `${box.rect.left}px`,
                  top: `${box.rect.top}px`,
                  width: `${Math.max(box.rect.width, 6)}px`,
                  height: `${Math.max(box.rect.height, 6)}px`,
                }}
              >
                <button
                  className={`prototype-annotation-layer__marker${isSelected ? ' is-selected' : ''}`}
                  type="button"
                  aria-label={`查看标注 ${box.index}`}
                  style={{
                    left: `${labelLeft - box.rect.left}px`,
                    top: `${labelTop - box.rect.top}px`,
                  }}
                  onClick={() => handleAnnotationClick(box.record.id)}
                >
                  {box.index}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {panelVisible && (
        <aside className="prototype-annotation-panel" ref={panelRef}>
          <div
            aria-label="调整标注抽屉宽度"
            aria-orientation="vertical"
            className="prototype-annotation-panel__resize-handle"
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') {
                event.preventDefault();
                resizePanelBy(24);
              } else if (event.key === 'ArrowRight') {
                event.preventDefault();
                resizePanelBy(-24);
              } else if (event.key === 'Home') {
                event.preventDefault();
                setPanelWidth(MIN_PANEL_WIDTH);
              } else if (event.key === 'End') {
                event.preventDefault();
                setPanelWidth(getPanelWidthLimit());
              }
            }}
            onPointerDown={handlePanelResizePointerDown}
            role="separator"
            tabIndex={0}
            title="拖动调整抽屉宽度"
          >
            <GripVertical size={14} aria-hidden />
          </div>
          <div className="prototype-annotation-panel__header">
            <div className="prototype-annotation-panel__title">
              <strong>
                {mode === 'view'
                  ? (expandedAnnotation
                    ? `标注 ${expandedAnnotationIndex} · ${expandedAnnotation.title || '未命名标注'}`
                    : '当前标注')
                  : (selectedAnnotation
                    ? `标注 ${selectedAnnotationIndex} · ${selectedAnnotation.title || '未命名标注'}`
                    : '编辑原型标注')}
              </strong>
              <span>{currentPageTitle} · {pageAnnotations.length} 条</span>
            </div>
            <div className="prototype-annotation-panel__header-actions">
              {mode === 'view' && expandedAnnotation && (
                <button
                  type="button"
                  onClick={() => setExpandedAnnotationId(null)}
                  title="返回标注列表"
                  aria-label="返回标注列表"
                >
                  <ArrowLeft size={15} aria-hidden />
                </button>
              )}
              {canShowEditor && selectedAnnotation && (
                <button type="button" onClick={handleDeleteSelectedAnnotation} title="删除标注">
                  <Trash2 size={15} aria-hidden />
                </button>
              )}
              <button type="button" onClick={closeAnnotationLayer} aria-label="关闭标注面板">
                <X size={15} aria-hidden />
              </button>
            </div>
          </div>
          {renderPanelContent()}
        </aside>
      )}

      {isVersionOverviewOpen && (
        <div className="prototype-version-overview-modal" role="presentation">
          <section
            aria-label="版本概览"
            aria-modal="true"
            className="prototype-version-overview-dialog"
            role="dialog"
          >
            <header className="prototype-version-overview-dialog__header">
              <div>
                <strong>版本概览</strong>
                <span>{overviewDrafts.length} 个版本</span>
                {isOverviewEditing && <em>编辑中</em>}
              </div>
              <div className="prototype-version-overview-dialog__header-actions">
                {ENABLE_EDITING && !isOverviewEditing && (
                  <button onClick={startVersionOverviewEditing} type="button">
                    <PencilLine size={15} aria-hidden />
                    编辑
                  </button>
                )}
                <button aria-label="关闭版本概览" onClick={closeVersionOverview} title="关闭" type="button">
                  <X size={17} aria-hidden />
                </button>
              </div>
            </header>

            <div className="prototype-version-overview-dialog__tabs-row">
              <div aria-label="原型版本列表" className="prototype-version-overview-dialog__tabs" role="tablist">
                {overviewDrafts.map((overview) => (
                  <button
                    aria-selected={overview.id === selectedOverviewId}
                    className={overview.id === selectedOverviewId ? 'is-active' : ''}
                    key={overview.id}
                    onClick={() => setSelectedOverviewId(overview.id)}
                    role="tab"
                    title={overview.label.trim() || '未命名版本'}
                    type="button"
                  >
                    {overview.label.trim() || '未命名版本'}
                  </button>
                ))}
              </div>
              {ENABLE_EDITING && isOverviewEditing && (
                <button
                  className="prototype-version-overview-dialog__add"
                  onClick={addVersionOverview}
                  type="button"
                >
                  <Plus size={15} aria-hidden />
                  添加版本
                </button>
              )}
            </div>

            {selectedOverview ? (
              <div className="prototype-version-overview-dialog__body">
                {ENABLE_EDITING && isOverviewEditing ? (
                  <label className="prototype-version-overview-dialog__version-field">
                    <span>版本标识 <i>*</i></span>
                    <input
                      aria-label="版本标识"
                      maxLength={40}
                      onChange={(event) => updateSelectedOverview((overview) => ({
                        ...overview,
                        label: event.target.value,
                        updatedAt: nowIso(),
                      }))}
                      placeholder="例如 V1.0"
                      value={selectedOverview.label}
                    />
                  </label>
                ) : (
                  <div className="prototype-version-overview-dialog__version-label">
                    {selectedOverview.label || '未命名版本'}
                  </div>
                )}

                <div className="prototype-version-overview-dialog__content-field">
                  <span>版本说明</span>
                  {ENABLE_EDITING && isOverviewEditing ? (
                    <AnnotationRichTextEditor
                      ariaLabel="版本说明富文本编辑区域"
                      onChange={(richTextHtml) => updateSelectedOverview((overview) => ({
                        ...overview,
                        richTextHtml,
                        updatedAt: nowIso(),
                      }))}
                      onError={(message) => toast('error', message)}
                      placeholder="在这里输入本版本说明"
                      toolbarLabel="版本说明格式工具"
                      value={selectedOverview.richTextHtml !== undefined
                        ? selectedOverview.richTextHtml
                        : markdownToRichTextHtml(selectedOverview.markdown)}
                    />
                  ) : (
                    <div className="prototype-version-overview-dialog__readonly-content">
                      <AnnotationMarkdownViewer
                        content={selectedOverview.markdown || '暂无版本说明'}
                        html={selectedOverview.richTextHtml}
                      />
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="prototype-version-overview-dialog__empty">
                <BookOpen size={28} aria-hidden />
                <strong>暂无版本说明</strong>
              </div>
            )}

            <footer className="prototype-version-overview-dialog__footer">
              <span aria-live="polite">
                {isOverviewEditing
                  ? (hasOverviewChanges ? '有未保存修改' : '编辑中，暂无修改')
                  : '当前为查看模式'}
              </span>
              <div>
                {ENABLE_EDITING && isOverviewEditing ? (
                  <>
                    <button onClick={cancelVersionOverviewEditing} type="button">取消编辑</button>
                    <button
                      className="is-primary"
                      disabled={!hasOverviewChanges || isOverviewSaving}
                      onClick={handleSaveVersionOverviews}
                      type="button"
                    >
                      <Save size={15} aria-hidden />
                      {isOverviewSaving ? '保存中' : '保存'}
                    </button>
                  </>
                ) : (
                  <button onClick={closeVersionOverview} type="button">关闭</button>
                )}
              </div>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
