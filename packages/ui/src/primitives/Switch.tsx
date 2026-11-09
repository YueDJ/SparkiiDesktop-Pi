export function Switch({ checked, onCheckedChange, label, disabled = false }: { checked: boolean; onCheckedChange(next: boolean): void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`ui-switch ${checked ? 'on' : ''}`}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
    />
  );
}
