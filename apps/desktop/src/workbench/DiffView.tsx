export function DiffView({ diff }: { diff: string }) {
  const lines = diff.split('\n');
  return (
    <pre className="diff" data-testid="diff-view">
      {lines.map((line, i) => {
        let cls = 'diff-ctx';
        if (line.startsWith('---') || line.startsWith('+++')) cls = 'diff-hdr';
        else if (line.startsWith('+')) cls = 'diff-add';
        else if (line.startsWith('-')) cls = 'diff-del';
        return (
          <div key={i} className={cls}>
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}
