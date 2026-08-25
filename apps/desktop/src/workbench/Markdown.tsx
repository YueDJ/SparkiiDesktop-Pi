import { useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

function CodeBlock(props: { className?: string; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = String(props.children ?? '').replace(/\n$/, '');
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div className="code-block" data-testid="code-block">
      <button type="button" className="copy-btn" data-testid="copy-btn" onClick={copy}>
        {copied ? '已复制' : '复制'}
      </button>
      <pre><code className={props.className}>{props.children}</code></pre>
    </div>
  );
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: (p) => <>{p.children}</>, code: CodeBlock }}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
