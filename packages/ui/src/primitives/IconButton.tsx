import { type ButtonHTMLAttributes } from 'react';
import { Button, type ButtonSize } from './Button.js';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  label: string;
  size?: ButtonSize;
}

export function IconButton({ label, size = 'md', className = '', ...rest }: IconButtonProps) {
  return (
    <Button variant="ghost" size={size} className={`ui-icon-btn ${className}`} aria-label={label} title={label} {...rest} />
  );
}
