import type { PageSchema } from '@sparkii/config';
import { widgetRegistry, type WidgetProps } from './registry.js';

export function PageComposer(props: { schema: PageSchema; state: Record<string, unknown>; onAction(a: string): void }) {
  const widgets = (props.schema.widgets as Array<WidgetProps>) ?? [];
  return (
    <div className="page" data-page={props.schema.page}>
      {widgets.map((w) => {
        const Widget = widgetRegistry[w.type as keyof typeof widgetRegistry];
        return <Widget key={w.id} {...w} state={props.state} onAction={props.onAction} />;
      })}
    </div>
  );
}
