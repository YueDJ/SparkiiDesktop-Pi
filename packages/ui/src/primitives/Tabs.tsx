export interface TabItem { id: string; label: string; }
export function Tabs({ tabs, active, onChange }: { tabs: TabItem[]; active: string; onChange(id: string): void }) {
  return (
    <div className="ui-tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={t.id === active} className={`ui-tab ${t.id === active ? 'on' : ''}`} onClick={() => onChange(t.id)}>{t.label}</button>
      ))}
    </div>
  );
}
