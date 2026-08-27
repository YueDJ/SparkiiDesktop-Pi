import type { TextareaHTMLAttributes } from 'react';

export function TextArea({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`ui-textarea ${className}`} {...props} />;
}
