import { useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const LANG_HINTS: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TSX', js: 'JavaScript', jsx: 'JSX', json: 'JSON',
  html: 'HTML', css: 'CSS', sh: 'Shell', bash: 'Bash', python: 'Python',
  py: 'Python', yaml: 'YAML', yml: 'YAML', md: 'Markdown', sql: 'SQL', go: 'Go',
  rust: 'Rust', rs: 'Rust', java: 'Java', c: 'C', cpp: 'C++', diff: 'Diff',
};

function CodeBlock(props: { className?: string; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = String(props.children ?? '').replace(/\n$/, '');
  const lang = /language-([\w+-]+)/.exec(props.className ?? '')?.[1] ?? '';
  const langLabel = (LANG_HINTS[lang.toLowerCase()] ?? lang) || '代码';
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="code-block" data-testid="code-block">
      <div className="code-block-head">
        <span className="code-block-lang">{langLabel}</span>
        <button type="button" className="copy-btn" data-testid="copy-btn" onClick={copy}>
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre><code className={props.className}>{props.children}</code></pre>
    </div>
  );
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: (p) => <>{p.children}</>,
          code: (p) => {
            const { className = '', children } = p as unknown as { className?: string; children?: ReactNode };
            const raw = String(children ?? '');
            const isBlock = /language-/.test(className) || raw.includes('\n');
            if (isBlock) return <CodeBlock className={className}>{children}</CodeBlock>;
            return <code className={className}>{children}</code>;
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
