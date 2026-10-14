import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bold, Columns3, Merge, Rows3, Table2, Trash2 } from 'lucide-react';
import { sanitizeAnnotationHtml } from './AnnotationMarkdownViewer';

type AnnotationRichTextEditorProps = {
  ariaLabel?: string;
  onChange: (html: string) => void;
  onError?: (message: string) => void;
  placeholder?: string;
  toolbarLabel?: string;
  value: string;
};

type TableContextMenuState = {
  x: number;
  y: number;
};

const FONT_SIZES = [12, 14, 16, 18, 20, 24] as const;
const FONT_COLORS = ['#111827', '#0f6bff', '#dc2626', '#16803c', '#b54708'] as const;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp']);

function readImageAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('无法读取剪贴板图片。'));
      }
    });
    reader.addEventListener('error', () => reject(new Error('无法读取剪贴板图片。')));
    reader.readAsDataURL(file);
  });
}

export default function AnnotationRichTextEditor({
  ariaLabel = '富文本编辑区域',
  onChange,
  onError,
  placeholder = '在这里输入交互说明 / 逻辑说明',
  toolbarLabel = '标注内容格式工具',
  value,
}: AnnotationRichTextEditorProps) {
  const editorRef = useRef<HTMLDivElement | null>(null);
  const savedRangeRef = useRef<Range | null>(null);
  const contextTableCellRef = useRef<HTMLTableCellElement | null>(null);
  const selectionAnchorCellRef = useRef<HTMLTableCellElement | null>(null);
  const selectedTableCellsRef = useRef<Set<HTMLTableCellElement>>(new Set());
  const [tableContextMenu, setTableContextMenu] = useState<TableContextMenuState | null>(null);

  useEffect(() => {
    const editor = editorRef.current;
    const safeValue = sanitizeAnnotationHtml(value);
    if (editor && editor.innerHTML !== safeValue) {
      editor.innerHTML = safeValue;
    }
  }, [value]);

  useEffect(() => {
    function closeContextMenu(event: MouseEvent) {
      const target = event.target;
      if (target instanceof Element && target.closest('.prototype-annotation-table-menu')) {
        return;
      }
      setTableContextMenu(null);
    }

    function closeContextMenuByKeyboard(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setTableContextMenu(null);
      }
    }

    document.addEventListener('mousedown', closeContextMenu);
    document.addEventListener('keydown', closeContextMenuByKeyboard);
    return () => {
      document.removeEventListener('mousedown', closeContextMenu);
      document.removeEventListener('keydown', closeContextMenuByKeyboard);
    };
  }, []);

  function saveSelection() {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) {
      return;
    }
    const range = selection.getRangeAt(0);
    if (editor.contains(range.commonAncestorContainer)) {
      savedRangeRef.current = range.cloneRange();
    }
  }

  function restoreSelection() {
    const selection = window.getSelection();
    const range = savedRangeRef.current;
    if (!selection || !range) {
      editorRef.current?.focus();
      return;
    }
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function emitChange() {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }
    const safeHtml = sanitizeAnnotationHtml(editor.innerHTML);
    if (editor.innerHTML !== safeHtml) {
      editor.innerHTML = safeHtml;
    }
    onChange(safeHtml);
    saveSelection();
  }

  function transformTypedHorizontalRule() {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) {
      return false;
    }

    const anchorElement = selection.anchorNode instanceof HTMLElement
      ? selection.anchorNode
      : selection.anchorNode?.parentElement;
    const candidateBlock = anchorElement?.closest('p, div') || null;
    const lineBlock = candidateBlock && candidateBlock !== editor && editor.contains(candidateBlock)
      ? candidateBlock
      : null;
    const lineText = (lineBlock?.textContent || editor.textContent || '').trim();
    if (!/^-{3,}$/u.test(lineText)) {
      return false;
    }

    const horizontalRule = document.createElement('hr');
    const trailingParagraph = document.createElement('p');
    trailingParagraph.appendChild(document.createElement('br'));
    if (lineBlock) {
      lineBlock.replaceWith(horizontalRule, trailingParagraph);
    } else if (/^-{3,}$/u.test(editor.textContent?.trim() || '')) {
      editor.replaceChildren(horizontalRule, trailingParagraph);
    } else {
      return false;
    }

    const nextRange = document.createRange();
    nextRange.selectNodeContents(trailingParagraph);
    nextRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(nextRange);
    savedRangeRef.current = nextRange.cloneRange();
    return true;
  }

  function clearSelectedTableCells() {
    selectedTableCellsRef.current.forEach((cell) => cell.classList.remove('is-table-cell-selected'));
    selectedTableCellsRef.current.clear();
  }

  function getTableCell(target: EventTarget | null) {
    if (!(target instanceof Element)) {
      return null;
    }
    const cell = target.closest('th, td');
    return cell instanceof HTMLTableCellElement && editorRef.current?.contains(cell) ? cell : null;
  }

  function selectTableCellRange(anchor: HTMLTableCellElement, target: HTMLTableCellElement) {
    const anchorTable = anchor.closest('table');
    const targetTable = target.closest('table');
    if (!(anchorTable instanceof HTMLTableElement) || anchorTable !== targetTable) {
      clearSelectedTableCells();
      return;
    }

    clearSelectedTableCells();
    const anchorRow = anchor.parentElement as HTMLTableRowElement;
    const targetRow = target.parentElement as HTMLTableRowElement;
    const startRow = Math.min(anchorRow.rowIndex, targetRow.rowIndex);
    const endRow = Math.max(anchorRow.rowIndex, targetRow.rowIndex);
    const startColumn = Math.min(anchor.cellIndex, target.cellIndex);
    const endColumn = Math.max(anchor.cellIndex, target.cellIndex);
    for (let rowIndex = startRow; rowIndex <= endRow; rowIndex += 1) {
      const row = anchorTable.rows[rowIndex];
      if (!row) {
        continue;
      }
      for (let columnIndex = startColumn; columnIndex <= endColumn; columnIndex += 1) {
        const cell = row.cells[columnIndex];
        if (cell) {
          cell.classList.add('is-table-cell-selected');
          selectedTableCellsRef.current.add(cell);
        }
      }
    }
  }

  function handleEditorMouseDown(event: React.MouseEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }
    setTableContextMenu(null);
    const cell = getTableCell(event.target);
    if (!cell) {
      clearSelectedTableCells();
      selectionAnchorCellRef.current = null;
      return;
    }

    const anchor = selectionAnchorCellRef.current;
    if (event.shiftKey && anchor && anchor.closest('table') === cell.closest('table')) {
      event.preventDefault();
      selectTableCellRange(anchor, cell);
      return;
    }

    clearSelectedTableCells();
    selectionAnchorCellRef.current = cell;
  }

  function handleEditorContextMenu(event: React.MouseEvent<HTMLDivElement>) {
    const cell = getTableCell(event.target);
    if (!cell) {
      setTableContextMenu(null);
      return;
    }

    event.preventDefault();
    if (!selectedTableCellsRef.current.has(cell)) {
      clearSelectedTableCells();
      cell.classList.add('is-table-cell-selected');
      selectedTableCellsRef.current.add(cell);
      selectionAnchorCellRef.current = cell;
    }
    contextTableCellRef.current = cell;
    setTableContextMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 218)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 286)),
    });
  }

  function createEmptyTableCell(tagName: 'td' | 'th') {
    const cell = document.createElement(tagName);
    cell.appendChild(document.createElement('br'));
    return cell;
  }

  function finishTableCommand() {
    clearSelectedTableCells();
    selectionAnchorCellRef.current = null;
    contextTableCellRef.current = null;
    setTableContextMenu(null);
    savedRangeRef.current = null;
    editorRef.current?.focus();
    emitChange();
  }

  function addTableRow() {
    const cell = contextTableCellRef.current;
    const row = cell?.parentElement;
    if (!(cell instanceof HTMLTableCellElement) || !(row instanceof HTMLTableRowElement)) {
      return;
    }

    const columnCount = Array.from(row.cells).reduce((total, currentCell) => total + currentCell.colSpan, 0);
    const newRow = document.createElement('tr');
    const cellTagName = Array.from(row.cells).every((currentCell) => currentCell.tagName === 'TH') ? 'th' : 'td';
    for (let index = 0; index < columnCount; index += 1) {
      newRow.appendChild(createEmptyTableCell(cellTagName));
    }
    row.parentNode?.insertBefore(newRow, row.nextSibling);
    finishTableCommand();
  }

  function deleteTableRow() {
    const cell = contextTableCellRef.current;
    const row = cell?.parentElement;
    const table = cell?.closest('table');
    if (!(row instanceof HTMLTableRowElement) || !(table instanceof HTMLTableElement)) {
      return;
    }

    row.remove();
    if (table.rows.length === 0) {
      table.remove();
    }
    finishTableCommand();
  }

  function addTableColumn() {
    const contextCell = contextTableCellRef.current;
    const table = contextCell?.closest('table');
    if (!(contextCell instanceof HTMLTableCellElement) || !(table instanceof HTMLTableElement)) {
      return;
    }

    const insertionIndex = contextCell.cellIndex + 1;
    Array.from(table.rows).forEach((row) => {
      const tagName = Array.from(row.cells).every((cell) => cell.tagName === 'TH') ? 'th' : 'td';
      const nextCell = row.cells[insertionIndex] || null;
      row.insertBefore(createEmptyTableCell(tagName), nextCell);
    });
    finishTableCommand();
  }

  function deleteTableColumn() {
    const contextCell = contextTableCellRef.current;
    const table = contextCell?.closest('table');
    if (!(contextCell instanceof HTMLTableCellElement) || !(table instanceof HTMLTableElement)) {
      return;
    }

    const deletionIndex = contextCell.cellIndex;
    Array.from(table.rows).forEach((row) => row.cells[deletionIndex]?.remove());
    if (Array.from(table.rows).every((row) => row.cells.length === 0)) {
      table.remove();
    }
    finishTableCommand();
  }

  function mergeSelectedTableCells() {
    const selectedCells = Array.from(selectedTableCellsRef.current);
    const contextCell = contextTableCellRef.current;
    const table = contextCell?.closest('table');
    if (!(table instanceof HTMLTableElement) || selectedCells.length < 2) {
      return;
    }

    const cellsInTable = selectedCells.filter((cell) => cell.closest('table') === table);
    const rowIndexes = cellsInTable.map((cell) => (cell.parentElement as HTMLTableRowElement).rowIndex);
    const columnIndexes = cellsInTable.map((cell) => cell.cellIndex);
    const startRow = Math.min(...rowIndexes);
    const endRow = Math.max(...rowIndexes);
    const startColumn = Math.min(...columnIndexes);
    const endColumn = Math.max(...columnIndexes);
    const expectedCellCount = (endRow - startRow + 1) * (endColumn - startColumn + 1);
    const containsMergedCell = cellsInTable.some((cell) => cell.rowSpan > 1 || cell.colSpan > 1);
    if (cellsInTable.length !== expectedCellCount || containsMergedCell) {
      onError?.('请选择一个尚未合并的矩形单元格区域。');
      return;
    }

    const leadingCell = table.rows[startRow]?.cells[startColumn];
    if (!leadingCell || !selectedTableCellsRef.current.has(leadingCell)) {
      onError?.('无法合并当前选择的单元格。');
      return;
    }

    cellsInTable.forEach((cell) => {
      if (cell === leadingCell) {
        return;
      }
      const hasContent = Boolean(cell.textContent?.trim() || cell.querySelector('img, table'));
      if (hasContent) {
        const leadingHasContent = Boolean(leadingCell.textContent?.trim() || leadingCell.querySelector('img, table'));
        if (leadingHasContent) {
          leadingCell.appendChild(document.createElement('br'));
        } else if (leadingCell.childNodes.length === 1 && leadingCell.firstChild instanceof HTMLBRElement) {
          leadingCell.replaceChildren();
        }
        while (cell.firstChild) {
          leadingCell.appendChild(cell.firstChild);
        }
      }
      cell.remove();
    });
    leadingCell.rowSpan = endRow - startRow + 1;
    leadingCell.colSpan = endColumn - startColumn + 1;
    finishTableCommand();
  }

  function preventTableMenuBlur(event: React.MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
  }

  function applyBold() {
    restoreSelection();
    editorRef.current?.focus();
    document.execCommand('bold', false);
    emitChange();
  }

  function applyInlineStyle(property: 'color' | 'fontSize', value: string) {
    restoreSelection();
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) {
      return;
    }
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) {
      return;
    }

    const span = document.createElement('span');
    span.style[property] = value;
    if (range.collapsed) {
      span.textContent = '文字';
    } else {
      span.appendChild(range.extractContents());
    }
    range.insertNode(span);
    range.selectNodeContents(span);
    selection.removeAllRanges();
    selection.addRange(range);
    savedRangeRef.current = range.cloneRange();
    emitChange();
  }

  function insertTable() {
    restoreSelection();
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) {
      return;
    }
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) {
      return;
    }

    const table = document.createElement('table');
    const body = document.createElement('tbody');
    for (let rowIndex = 0; rowIndex < 3; rowIndex += 1) {
      const row = document.createElement('tr');
      for (let columnIndex = 0; columnIndex < 3; columnIndex += 1) {
        const cell = document.createElement(rowIndex === 0 ? 'th' : 'td');
        cell.textContent = rowIndex === 0 ? `列 ${columnIndex + 1}` : '内容';
        row.appendChild(cell);
      }
      body.appendChild(row);
    }
    table.appendChild(body);
    range.collapse(false);
    range.insertNode(table);

    const firstCell = table.querySelector('th, td');
    if (firstCell) {
      range.selectNodeContents(firstCell);
      selection.removeAllRanges();
      selection.addRange(range);
      savedRangeRef.current = range.cloneRange();
    }
    emitChange();
  }

  async function handlePaste(event: React.ClipboardEvent<HTMLDivElement>) {
    const imageFiles = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === 'file' && SUPPORTED_IMAGE_TYPES.has(item.type.toLowerCase()))
      .map((item) => item.getAsFile())
      .filter((file): file is File => Boolean(file));

    event.preventDefault();
    if (imageFiles.length === 0) {
      document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
      emitChange();
      return;
    }

    if (imageFiles.some((file) => file.size > MAX_IMAGE_BYTES)) {
      onError?.('单张粘贴图片不能超过 5 MB。');
      return;
    }

    saveSelection();
    try {
      const imageDataUrls = await Promise.all(imageFiles.map(readImageAsDataUrl));
      restoreSelection();

      const editor = editorRef.current;
      const selection = window.getSelection();
      if (!editor || !selection || selection.rangeCount === 0) {
        throw new Error('无法定位图片粘贴位置。');
      }
      const range = selection.getRangeAt(0);
      if (!editor.contains(range.commonAncestorContainer)) {
        throw new Error('无法定位图片粘贴位置。');
      }

      const fragment = document.createDocumentFragment();
      imageDataUrls.forEach((src, index) => {
        const image = document.createElement('img');
        image.src = src;
        image.alt = imageFiles[index].name || '粘贴图片';
        fragment.appendChild(image);
      });
      const trailingParagraph = document.createElement('p');
      trailingParagraph.appendChild(document.createElement('br'));
      fragment.appendChild(trailingParagraph);

      range.deleteContents();
      range.insertNode(fragment);
      range.setStart(trailingParagraph, 0);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      savedRangeRef.current = range.cloneRange();
      emitChange();
    } catch (error) {
      onError?.(error instanceof Error ? error.message : '粘贴图片失败。');
    }
  }

  return (
    <div className="prototype-annotation-rich-editor">
      <div className="prototype-annotation-panel__editor-toolbar" aria-label={toolbarLabel}>
        <button
          aria-label="加粗"
          onMouseDown={(event) => {
            event.preventDefault();
            saveSelection();
          }}
          onClick={applyBold}
          title="加粗"
          type="button"
        >
          <Bold size={14} aria-hidden />
        </button>
        <select
          aria-label="字体大小"
          defaultValue=""
          onMouseDown={saveSelection}
          onChange={(event) => {
            if (event.currentTarget.value) {
              applyInlineStyle('fontSize', `${event.currentTarget.value}px`);
              event.currentTarget.value = '';
            }
          }}
          title="字体大小"
        >
          <option value="">字号</option>
          {FONT_SIZES.map((fontSize) => <option key={fontSize} value={fontSize}>{fontSize}px</option>)}
        </select>
        <div className="prototype-annotation-panel__color-tools" aria-label="字体颜色">
          {FONT_COLORS.map((color) => (
            <button
              aria-label={`字体颜色 ${color}`}
              className="prototype-annotation-panel__color-swatch"
              key={color}
              onMouseDown={(event) => {
                event.preventDefault();
                saveSelection();
              }}
              onClick={() => applyInlineStyle('color', color)}
              style={{ '--annotation-swatch-color': color } as React.CSSProperties}
              title={`字体颜色 ${color}`}
              type="button"
            />
          ))}
        </div>
        <button
          aria-label="插入表格"
          onMouseDown={(event) => {
            event.preventDefault();
            saveSelection();
          }}
          onClick={insertTable}
          title="插入 3 列表格"
          type="button"
        >
          <Table2 size={14} aria-hidden />
        </button>
      </div>
      <div
        aria-label={ariaLabel}
        aria-multiline="true"
        className="prototype-annotation-rich-editor__content annotation-markdown"
        contentEditable
        data-placeholder={placeholder}
        onBlur={emitChange}
        onContextMenu={handleEditorContextMenu}
        onInput={emitChange}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
            return;
          }
          if (transformTypedHorizontalRule()) {
            event.preventDefault();
            emitChange();
          }
        }}
        onKeyUp={saveSelection}
        onMouseDown={handleEditorMouseDown}
        onMouseUp={saveSelection}
        onPaste={handlePaste}
        ref={editorRef}
        role="textbox"
        suppressContentEditableWarning
      />
      {tableContextMenu && createPortal(
        <div
          aria-label="表格操作"
          className="prototype-annotation-table-menu"
          onContextMenu={(event) => event.preventDefault()}
          role="menu"
          style={{ left: tableContextMenu.x, top: tableContextMenu.y }}
        >
          <button onClick={addTableRow} onMouseDown={preventTableMenuBlur} role="menuitem" type="button">
            <Rows3 size={15} aria-hidden />
            在下方添加行
          </button>
          <button onClick={deleteTableRow} onMouseDown={preventTableMenuBlur} role="menuitem" type="button">
            <Trash2 size={15} aria-hidden />
            删除当前行
          </button>
          <button onClick={addTableColumn} onMouseDown={preventTableMenuBlur} role="menuitem" type="button">
            <Columns3 size={15} aria-hidden />
            在右侧添加列
          </button>
          <button onClick={deleteTableColumn} onMouseDown={preventTableMenuBlur} role="menuitem" type="button">
            <Trash2 size={15} aria-hidden />
            删除当前列
          </button>
          <div className="prototype-annotation-table-menu__divider" />
          <button
            disabled={selectedTableCellsRef.current.size < 2}
            onClick={mergeSelectedTableCells}
            onMouseDown={preventTableMenuBlur}
            role="menuitem"
            type="button"
          >
            <Merge size={15} aria-hidden />
            合并所选单元格
          </button>
          <p>合并：点击起始格，再按住 Shift 点击结束格</p>
        </div>,
        document.body
      )}
    </div>
  );
}
