import type { ReactNode } from 'react';

export function Toast({ children }: { children: ReactNode }) {
  return <div className="ui-toast" role="status">{children}</div>;
}
