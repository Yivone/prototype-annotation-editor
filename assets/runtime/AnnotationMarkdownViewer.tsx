import React from 'react';

type AnnotationMarkdownViewerProps = {
  className?: string;
  content: string;
  html?: string;
};

type InlineToken = {
  content: string;
  end: number;
  kind: 'bold' | 'code' | 'color' | 'size';
  value?: string;
};

const INLINE_TOKEN_PATTERN = /`[^`]+`|\*\*[^*]+\*\*|\[size=(12|14|16|18|20|24)\]|\[color=(#[0-9a-fA-F]{6})\]/gu;
const DATA_IMAGE_PATTERN = /^data:image\/(?:gif|jpeg|png|webp);base64,[a-z0-9+/]+={0,2}$/iu;
const ALLOWED_RICH_TEXT_TAGS = new Set([
  'B', 'BLOCKQUOTE', 'BR', 'CODE', 'DIV', 'EM', 'H1', 'H2', 'H3', 'HR', 'IMG', 'LI', 'OL', 'P', 'SPAN', 'STRONG',
  'TABLE', 'TBODY', 'TD', 'TH', 'THEAD', 'TR', 'U', 'UL',
]);

function escapeHtml(value: string) {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#039;');
}

export function sanitizeAnnotationHtml(html: string) {
  if (typeof DOMParser === 'undefined') {
    return escapeHtml(html);
  }

  const parsed = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  const root = parsed.body.firstElementChild;
  if (!root) {
    return '';
  }

  Array.from(root.querySelectorAll('script, style, iframe, object, embed')).forEach((element) => element.remove());
  Array.from(root.querySelectorAll('*')).forEach((element) => {
    if (!ALLOWED_RICH_TEXT_TAGS.has(element.tagName)) {
      element.replaceWith(...Array.from(element.childNodes));
      return;
    }

    const fontSize = element instanceof HTMLElement ? element.style.fontSize : '';
    const color = element instanceof HTMLElement ? element.style.color : '';
    const textAlign = element instanceof HTMLElement ? element.style.textAlign : '';
    const colspan = element.getAttribute('colspan');
    const rowspan = element.getAttribute('rowspan');
    const imageSrc = element.tagName === 'IMG' ? element.getAttribute('src') || '' : '';
    const imageAlt = element.tagName === 'IMG' ? element.getAttribute('alt') || '' : '';
    Array.from(element.attributes).forEach((attribute) => element.removeAttribute(attribute.name));

    if (element.tagName === 'IMG') {
      if (!DATA_IMAGE_PATTERN.test(imageSrc)) {
        element.remove();
        return;
      }
      element.setAttribute('src', imageSrc);
      element.setAttribute('alt', imageAlt.slice(0, 160));
      element.setAttribute('decoding', 'async');
      return;
    }

    if (element instanceof HTMLElement) {
      if (/^(1[0-9]|2[0-4])px$/u.test(fontSize)) {
        element.style.fontSize = fontSize;
      }
      if (/^(#[0-9a-f]{3,8}|rgba?\([\d\s,.%]+\))$/iu.test(color)) {
        element.style.color = color;
      }
      if (['left', 'center', 'right'].includes(textAlign)) {
        element.style.textAlign = textAlign;
      }
    }
    if (['TD', 'TH'].includes(element.tagName)) {
      if (colspan && /^[1-9]$|^10$/u.test(colspan)) {
        element.setAttribute('colspan', colspan);
      }
      if (rowspan && /^[1-9]$|^10$/u.test(rowspan)) {
        element.setAttribute('rowspan', rowspan);
      }
    }
  });

  return root.innerHTML.replace(/\u200B/gu, '');
}

function findInlineToken(text: string, start: number): InlineToken | null {
  INLINE_TOKEN_PATTERN.lastIndex = start;
  const match = INLINE_TOKEN_PATTERN.exec(text);
  if (!match || match.index !== start) {
    return null;
  }

  const token = match[0];
  if (token.startsWith('`')) {
    return { kind: 'code', content: token.slice(1, -1), end: INLINE_TOKEN_PATTERN.lastIndex };
  }
  if (token.startsWith('**')) {
    return { kind: 'bold', content: token.slice(2, -2), end: INLINE_TOKEN_PATTERN.lastIndex };
  }

  const kind = token.startsWith('[size=') ? 'size' : 'color';
  const closingToken = kind === 'size' ? '[/size]' : '[/color]';
  const closingIndex = text.indexOf(closingToken, INLINE_TOKEN_PATTERN.lastIndex);
  if (closingIndex < 0) {
    return null;
  }

  return {
    kind,
    value: match[1] || match[2],
    content: text.slice(INLINE_TOKEN_PATTERN.lastIndex, closingIndex),
    end: closingIndex + closingToken.length,
  };
}

function inlineMarkdownToHtml(text: string) {
  let html = '';
  let cursor = 0;
  let textStart = 0;

  while (cursor < text.length) {
    const token = findInlineToken(text, cursor);
    if (!token) {
      cursor += 1;
      continue;
    }
    if (textStart < cursor) {
      html += escapeHtml(text.slice(textStart, cursor));
    }
    const content = inlineMarkdownToHtml(token.content);
    if (token.kind === 'code') {
      html += `<code>${content}</code>`;
    } else if (token.kind === 'bold') {
      html += `<strong>${content}</strong>`;
    } else if (token.kind === 'size') {
      html += `<span style="font-size: ${token.value}px">${content}</span>`;
    } else {
      html += `<span style="color: ${token.value}">${content}</span>`;
    }
    cursor = token.end;
    textStart = cursor;
  }

  if (textStart < text.length) {
    html += escapeHtml(text.slice(textStart));
  }
  return html;
}

function parseInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  let textStart = 0;

  while (cursor < text.length) {
    const token = findInlineToken(text, cursor);
    if (!token) {
      cursor += 1;
      continue;
    }

    if (textStart < cursor) {
      nodes.push(text.slice(textStart, cursor));
    }

    const key = `${keyPrefix}-${cursor}`;
    if (token.kind === 'code') {
      nodes.push(<code key={key}>{token.content}</code>);
    } else if (token.kind === 'bold') {
      nodes.push(<strong key={key}>{parseInline(token.content, key)}</strong>);
    } else if (token.kind === 'size') {
      nodes.push(
        <span key={key} style={{ fontSize: `${token.value}px` }}>
          {parseInline(token.content, key)}
        </span>
      );
    } else {
      nodes.push(
        <span key={key} style={{ color: token.value }}>
          {parseInline(token.content, key)}
        </span>
      );
    }

    cursor = token.end;
    textStart = cursor;
  }

  if (textStart < text.length) {
    nodes.push(text.slice(textStart));
  }
  return nodes;
}

function splitTableRow(line: string) {
  return line
    .trim()
    .replace(/^\|/u, '')
    .replace(/\|$/u, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isTableDivider(line: string) {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell));
}

export function markdownToRichTextHtml(markdown: string) {
  const lines = markdown.split('\n');
  const blocks: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const nextLine = lines[index + 1];
    if (/^-{3,}\s*$/u.test(line)) {
      blocks.push('<hr>');
      continue;
    }
    if (line.includes('|') && nextLine && isTableDivider(nextLine)) {
      const headers = splitTableRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      index -= 1;
      blocks.push(
        `<table><thead><tr>${headers.map((cell) => `<th>${inlineMarkdownToHtml(cell)}</th>`).join('')}</tr></thead>` +
        `<tbody>${rows.map((row) => `<tr>${headers.map((_, cellIndex) => `<td>${inlineMarkdownToHtml(row[cellIndex] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table>`
      );
      continue;
    }

    const content = inlineMarkdownToHtml(line.replace(/^#{1,3}\s/u, '').replace(/^[->]\s/u, '').replace(/^\d+\.\s/u, ''));
    if (line.startsWith('### ')) {
      blocks.push(`<h3>${content}</h3>`);
    } else if (line.startsWith('## ')) {
      blocks.push(`<h2>${content}</h2>`);
    } else if (line.startsWith('# ')) {
      blocks.push(`<h1>${content}</h1>`);
    } else if (line.startsWith('> ')) {
      blocks.push(`<blockquote>${content}</blockquote>`);
    } else if (!line.trim()) {
      blocks.push('<p><br></p>');
    } else {
      blocks.push(`<p>${content}</p>`);
    }
  }

  return sanitizeAnnotationHtml(blocks.join(''));
}

function renderLine(line: string, index: number) {
  const key = `line-${index}`;
  if (line.startsWith('### ')) {
    return <h3 key={key}>{parseInline(line.slice(4), key)}</h3>;
  }
  if (line.startsWith('## ')) {
    return <h2 key={key}>{parseInline(line.slice(3), key)}</h2>;
  }
  if (line.startsWith('# ')) {
    return <h1 key={key}>{parseInline(line.slice(2), key)}</h1>;
  }
  if (line.startsWith('- ')) {
    return <li key={key}>{parseInline(line.slice(2), key)}</li>;
  }
  const orderedListMatch = line.match(/^\d+\.\s(.*)$/u);
  if (orderedListMatch) {
    return <li className="is-ordered" key={key}>{parseInline(orderedListMatch[1], key)}</li>;
  }
  if (line.startsWith('> ')) {
    return <blockquote key={key}>{parseInline(line.slice(2), key)}</blockquote>;
  }
  if (/^-{3,}$/u.test(line.trim())) {
    return <hr key={key} />;
  }
  if (!line.trim()) {
    return <div className="annotation-markdown__spacer" key={key} />;
  }
  return <p key={key}>{parseInline(line, key)}</p>;
}

export default function AnnotationMarkdownViewer({ className = '', content, html }: AnnotationMarkdownViewerProps) {
  if (html !== undefined) {
    return (
      <div
        className={`annotation-markdown ${className}`.trim()}
        dangerouslySetInnerHTML={{ __html: sanitizeAnnotationHtml(html) }}
      />
    );
  }

  const lines = content.split('\n');
  const blocks: React.ReactNode[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const nextLine = lines[index + 1];
    if (line.includes('|') && nextLine && isTableDivider(nextLine)) {
      const headers = splitTableRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      index -= 1;
      blocks.push(
        <div className="annotation-markdown__table-wrap" key={`table-${index}`}>
          <table>
            <thead>
              <tr>{headers.map((cell, cellIndex) => <th key={cellIndex}>{parseInline(cell, `th-${index}-${cellIndex}`)}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {headers.map((_, cellIndex) => (
                    <td key={cellIndex}>{parseInline(row[cellIndex] || '', `td-${index}-${rowIndex}-${cellIndex}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
      continue;
    }
    blocks.push(renderLine(line, index));
  }

  return <div className={`annotation-markdown ${className}`.trim()}>{blocks}</div>;
}
