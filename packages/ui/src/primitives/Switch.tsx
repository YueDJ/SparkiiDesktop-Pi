export function Switch({ checked, onCheckedChange, label }: { checked: boolean; onCheckedChange(next: boolean): void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} className={`ui-switch ${checked ? 'on' : ''}`} onClick={() => onCheckedChange(!checked)} />
  );
}
