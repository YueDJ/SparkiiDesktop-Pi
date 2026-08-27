import type { InputHTMLAttributes } from 'react';

export function TextField({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`ui-field ${className}`} {...props} />;
}
