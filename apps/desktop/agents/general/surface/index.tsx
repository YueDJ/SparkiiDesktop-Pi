import type { SparkiiApi } from '../../../src/types/sparkii-api.js';
import { StandardChatSurface } from '../../../src/surface/standard-chat.js';

// Public chat timeline primitives (moved to @sparkii/ui) exposed for convenience.
export { applyChatEvent, normalizeMessages, type ChatEntry } from '@sparkii/ui';

export interface GeneralChatSurfaceProps {
  api: SparkiiApi;
  sessionId: string | null;
  active?: boolean;
  draft?: boolean;
  onNewSession(): void;
  onSessionCommitted?(sessionId: string, title?: string): void;
}

/** Backward-compat adapter: renders the platform-standard chat surface. */
export function GeneralChatSurface(props: GeneralChatSurfaceProps) {
  const { api, sessionId, active = true, draft, onNewSession, onSessionCommitted } = props;
  return (
    <StandardChatSurface
      agent={{ id: 'general', name: '通用智能体', surfaceType: 'chat' }}
      sessionId={sessionId}
      mode={active ? 'live' : 'history'}
      session={{ entries: [], streaming: false, meta: {} }}
      draft={draft}
      actions={{
        newSession: onNewSession,
        openSession: (id, title) => onSessionCommitted?.(id, title),
        startWorkflow: () => {},
        review: () => {},
        requestExport: () => {},
        chooseDocument: async () => ({}),
      }}
      api={api}
      active={active}
    />
  );
}

export default StandardChatSurface;
