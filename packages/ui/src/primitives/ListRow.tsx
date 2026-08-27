import type { HTMLAttributes, ReactNode } from 'react';

export function ListRow({ current = false, trailing, children, className = '', ...rest }: HTMLAttributes<HTMLDivElement> & { current?: boolean; trailing?: ReactNode }) {
  return <div className={`ui-list-row ${current ? 'current' : ''} ${className}`} {...rest}>{children}{trailing}</div>;
}
