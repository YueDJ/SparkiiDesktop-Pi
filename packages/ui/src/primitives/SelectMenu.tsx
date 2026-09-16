import { useRef, useState } from 'react';
import { ChevronDownIcon } from '../icons/index.js';
import { Menu, MenuItem } from './Menu.js';

export interface SelectMenuOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export function SelectMenu({
  value,
  options,
  onChange,
  placeholder,
  disabled,
  className = '',
  variant = 'field',
  'aria-label': ariaLabel,
  'data-testid': testId,
  placement = 'bottom',
}: {
  value: string;
  options: SelectMenuOption[];
  onChange(value: string): void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** `field` keeps `.ui-select` chrome; `plain` is for page-owned trigger styles. */
  variant?: 'field' | 'plain';
  'aria-label'?: string;
  'data-testid'?: string;
  placement?: 'top' | 'bottom';
}) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);
  const label = selected?.label ?? placeholder ?? '';
  const close = () => setOpen(false);
  const triggerClass = [
    'ui-select-menu-trigger',
    variant === 'field' ? 'ui-select' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <div ref={wrapperRef} className="ui-select-menu">
      <button
        type="button"
        role="combobox"
        className={triggerClass}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={testId}
        value={value}
        disabled={disabled}
        onClick={() => { if (!disabled) setOpen((current) => !current); }}
      >
        <span className="ui-select-menu-label">{label}</span>
        <ChevronDownIcon className="ui-select-menu-caret" />
      </button>
      {open && !disabled && (
        <Menu open onClose={close} containerRef={wrapperRef} placement={placement} align="start">
          {options.map((option) => (
            <MenuItem
              key={option.value}
              label={option.label}
              disabled={option.disabled}
              current={option.value === value}
              trailing={option.value === value ? '✓' : ''}
              onSelect={() => { close(); onChange(option.value); }}
            />
          ))}
        </Menu>
      )}
    </div>
  );
}
