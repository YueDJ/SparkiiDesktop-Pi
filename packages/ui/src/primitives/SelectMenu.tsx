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
  'aria-label'?: string;
  'data-testid'?: string;
  placement?: 'top' | 'bottom';
}) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);
  const label = selected?.label ?? placeholder ?? '';
  const close = () => setOpen(false);
  const fieldLike = !className;

  return (
    <div ref={wrapperRef} className="ui-select-menu">
      <button
        type="button"
        className={`ui-select-menu-trigger ${fieldLike ? 'ui-select' : className}`}
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
          {options.filter((option) => !option.disabled).map((option) => (
            <MenuItem
              key={option.value}
              label={option.label}
              trailing={option.value === value ? '✓' : ''}
              onSelect={() => { close(); onChange(option.value); }}
            />
          ))}
        </Menu>
      )}
    </div>
  );
}
