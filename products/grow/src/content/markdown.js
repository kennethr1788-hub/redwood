import {remark} from 'remark';
import {clean, urlOf} from './ledger.js';

export const escapeHtml = value => String(value).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
export const md = value => clean(value).replace(/[\\`*_{}\[\]<>#!|~]/g, '\\$&');
export const mdUrl = value => value.replace(/[()<>'"\\]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function validateMarkdown(markdown) {
  if (typeof markdown !== 'string' || Buffer.byteLength(markdown) > 200_000) throw new Error('Article must be Markdown text smaller than 200 KB.');
  return {valid: true, nodes: remark().parse(markdown).children.length};
}

/** Render the existing CommonMark AST through a fixed tag allowlist. No raw HTML,
 * remote images, scripts or executable URLs are interpreted from source/editor text.
 */
export function markdownToHtml(markdown, metadata = {}) {
  validateMarkdown(markdown);
  function render(node) {
    const children = () => (node.children || []).map(render).join('');
    switch (node.type) {
      case 'root': return children();
      case 'text': case 'html': return escapeHtml(node.value);
      case 'paragraph': return `<p>${children()}</p>\n`;
      case 'heading': return `<h${node.depth}>${children()}</h${node.depth}>\n`;
      case 'strong': return `<strong>${children()}</strong>`;
      case 'emphasis': return `<em>${children()}</em>`;
      case 'blockquote': return `<blockquote>${children()}</blockquote>\n`;
      case 'inlineCode': return `<code>${escapeHtml(node.value)}</code>`;
      case 'code': return `<pre><code>${escapeHtml(node.value)}</code></pre>\n`;
      case 'list': { const tag = node.ordered ? 'ol' : 'ul'; return `<${tag}>${children()}</${tag}>\n`; }
      case 'listItem': return `<li>${children()}</li>`;
      case 'link': return urlOf(node.url) ? `<a href="${escapeHtml(urlOf(node.url))}" rel="noreferrer">${children()}</a>` : children();
      case 'image': return escapeHtml(node.alt || '');
      case 'break': return '<br>\n';
      case 'thematicBreak': return '<hr>\n';
      default: return children();
    }
  }
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'"><title>${escapeHtml(metadata.title || 'Content draft')}</title><meta name="description" content="${escapeHtml(metadata.description || '')}"></head><body>\n${render(remark().parse(markdown))}</body></html>\n`;
}
