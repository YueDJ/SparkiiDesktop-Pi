import type { HTMLAttributes } from 'react';

export function Card({ children, className = '', ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={`ui-card ${className}`} {...rest}>{children}</div>;
}
