import { escapeHtml } from "../core/format.js";

export function renderAgentMessage(text) {
  const source = String(text);
  const blocks = [];
  const pattern = /```([^\n`]*)\n?([\s\S]*?)```/g;
  let cursor = 0;
  let match;

  while ((match = pattern.exec(source))) {
    if (match.index > cursor) {
      blocks.push(renderMarkdownText(source.slice(cursor, match.index)));
    }
    const language = match[1].trim() || "code";
    const code = match[2].replace(/\n$/, "");
    blocks.push(`
      <div class="code-block">
        <div class="code-head">
          <span>${escapeHtml(language)}</span>
          <button type="button" class="copy-code">Копировать</button>
        </div>
        <pre><code>${highlightCode(code, language)}</code></pre>
      </div>
    `);
    cursor = pattern.lastIndex;
  }

  if (cursor < source.length) {
    blocks.push(renderMarkdownText(source.slice(cursor)));
  }

  return blocks.join("");
}

export function renderMarkdownText(text) {
  return escapeHtml(text)
    .replace(/`([^`\n]+)`/g, '<code class="inline-code">$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br>");
}

export function highlightCode(code, language) {
  let html = escapeHtml(code);
  const normalized = language.toLowerCase();

  if (["js", "javascript", "ts", "typescript", "jsx", "tsx"].includes(normalized)) {
    html = html
      .replace(
        /\b(const|let|var|function|return|if|else|for|while|class|new|import|from|export|async|await|try|catch|throw|type|interface|extends|implements)\b/g,
        '<span class="syntax-keyword">$1</span>',
      )
      .replace(/\b(true|false|null|undefined)\b/g, '<span class="syntax-value">$1</span>')
      .replace(/(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;|`[^`]*?`)/g, '<span class="syntax-string">$1</span>');
  } else if (["json", "jsonc"].includes(normalized)) {
    html = html
      .replace(/(&quot;.*?&quot;)(\s*:)/g, '<span class="syntax-key">$1</span>$2')
      .replace(/\b(true|false|null|-?\d+(?:\.\d+)?)\b/g, '<span class="syntax-value">$1</span>');
  } else if (["sh", "bash", "shell", "zsh"].includes(normalized)) {
    html = html
      .replace(/^(\s*)(\$|#)(.*)$/gm, '$1<span class="syntax-prompt">$2</span>$3')
      .replace(/\b(cd|npm|pnpm|yarn|git|node|npx|docker|curl|export|sudo)\b/g, '<span class="syntax-keyword">$1</span>');
  }

  return html;
}
