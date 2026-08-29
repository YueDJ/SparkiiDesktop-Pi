import { Fragment, useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import { TextField } from '../primitives/TextField.js';
import { PinIcon, ArchiveIcon, RestoreIcon, StopIcon, AgentGlyph, ChevronDownIcon, ChevronRightIcon } from '../icons/index.js';

export interface SessionListItem {
  id: string;
  name: string;
  active?: boolean;
  pinned?: boolean;
  archived?: boolean;
  running?: boolean;
  queued?: boolean;
  updatedAt?: number;
  sortOrder?: number | null;
}

export interface SessionGroup {
  agentId: string;
  agentName: string;
  sessions: SessionListItem[];
}

export interface SessionListProps {
  groups: SessionGroup[];
  filter?: string;
  onOpen(agentId: string, sessionId: string): void;
  onRename?(agentId: string, sessionId: string): void;
  onDelete?(agentId: string, sessionId: string): void;
  onPin?(agentId: string, sessionId: string, pinned: boolean): void;
  onArchive?(agentId: string, sessionId: string, archived: boolean): void;
  onStop?(sessionId: string): void | Promise<void>;
  onRelease?(sessionId: string): void | Promise<void>;
  onReorder?(agentId: string, orderedSessionIds: string[]): void;
  renaming?: { agentId: string; sessionId: string } | null;
  renameDraft?: string;
  onRenameChange?(value: string): void;
  onRenameCommit?(agentId: string, sessionId: string): void;
  onRenameCancel?(): void;
}

type MenuState = { x: number; y: number; agentId: string; sessionId: string; pinned: boolean; archived: boolean; running: boolean };
type DragState = { agentId: string; sessionId: string };

export function SessionList({
  groups, filter = '', onOpen, onRename, onDelete, onPin, onArchive, onStop, onRelease, onReorder,
  renaming = null, renameDraft = '', onRenameChange, onRenameCommit, onRenameCancel,
}: SessionListProps) {
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [expandedArchived, setExpandedArchived] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<DragState | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null); };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('pointerdown', onPointerDown, true); document.removeEventListener('keydown', onKey); };
  }, [menu]);

  const visibleOf = (g: SessionGroup) => g.sessions.filter((s) => !s.archived);
  const archivedOf = (g: SessionGroup) => g.sessions.filter((s) => s.archived);

  const toggleCollapsed = (agentId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId); else next.add(agentId);
      return next;
    });
  };

  const toggleArchiveGroup = (agentId: string) => {
    setExpandedArchived((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId); else next.add(agentId);
      return next;
    });
  };

  const openMenu = (e: MouseEvent, s: SessionListItem, agentId: string) => {
    e.preventDefault();
    e.stopPropagation();
    const width = 220;
    const height = 268;
    setMenu({
      x: Math.max(4, Math.min(e.clientX, window.innerWidth - width - 4)),
      y: Math.max(4, Math.min(e.clientY, window.innerHeight - height - 4)),
      agentId, sessionId: s.id,
      pinned: !!s.pinned, archived: !!s.archived, running: !!s.running,
    });
  };

  const handleDragStart = (e: DragEvent, agentId: string, sessionId: string) => {
    setDrag({ agentId, sessionId });
    setOverIndex(null);
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', sessionId); } catch { /* noop */ }
  };

  const handleDrop = (agentId: string, dropIndex: number) => {
    if (!drag || drag.agentId !== agentId) { setDrag(null); setOverIndex(null); return; }
    const group = groups.find((g) => g.agentId === agentId);
    if (group) {
      const ids = visibleOf(group).map((s) => s.id);
      const from = ids.indexOf(drag.sessionId);
      if (from >= 0) {
        ids.splice(from, 1);
        let target = dropIndex;
        if (from < dropIndex) target -= 1;
        ids.splice(Math.max(0, Math.min(target, ids.length)), 0, drag.sessionId);
        onReorder?.(agentId, ids);
      }
    }
    setDrag(null);
    setOverIndex(null);
  };

  const renderRow = (s: SessionListItem, agentId: string, vis: SessionListItem[]) => {
    const isRenaming = renaming?.agentId === agentId && renaming.sessionId === s.id;
    return (
      <div
        key={s.id}
        className={`ui-session-row ${s.active ? 'current' : ''} ${s.archived ? 'archived' : ''}`}
        data-testid={`session-${s.id}`}
        draggable={!isRenaming}
        onClick={() => onOpen(agentId, s.id)}
        onContextMenu={(e) => openMenu(e, s, agentId)}
        onDragStart={(e) => handleDragStart(e, agentId, s.id)}
        onDragOver={(e) => {
          if (drag?.agentId !== agentId) { setOverIndex(null); return; }
          if (s.archived) return;
          e.preventDefault();
          e.stopPropagation();
          const idx = vis.indexOf(s);
          const rect = e.currentTarget.getBoundingClientRect();
          const before = e.clientY < rect.top + rect.height / 2;
          setOverIndex(before ? idx : idx + 1);
        }}
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); handleDrop(agentId, overIndex ?? vis.length); }}
        onDragEnd={() => { setDrag(null); setOverIndex(null); }}
        title={`右键管理：${s.name}`}
      >
        {s.pinned && <PinIcon className="ui-session-pin" />}
        {isRenaming ? (
          <TextField
            className="ui-session-rename"
            value={renameDraft}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => onRenameChange?.(e.target.value)}
            onBlur={() => onRenameCommit?.(agentId, s.id)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onRenameCommit?.(agentId, s.id);
              if (e.key === 'Escape') onRenameCancel?.();
            }}
          />
        ) : (
          <span className="ui-session-name" title={s.name}>{s.name}</span>
        )}
        <span className="ui-session-status">
          {s.running && <span className="ui-spinner" aria-label="运行中" />}
          {s.queued && <span className="ui-badge">排队</span>}
        </span>
      </div>
    );
  };

  const flatCount = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return groups.reduce((n, g) => n + g.sessions.filter((s) => !s.archived && (!q || s.name.toLowerCase().includes(q))).length, 0);
  }, [groups, filter]);
  if (groups.length === 0 && flatCount === 0) {
    return <div className="ui-session-list ui-session-empty"><div className="ui-muted">暂无会话</div></div>;
  }
  const hasFilter = filter.trim().length > 0;

  return (
    <div className="ui-session-list">
      {groups.map((g) => {
        const visible = visibleOf(g).filter((s) => !hasFilter || s.name.toLowerCase().includes(filter.trim().toLowerCase()));
        const archived = archivedOf(g).filter((s) => !hasFilter || s.name.toLowerCase().includes(filter.trim().toLowerCase()));
        const showArchived = expandedArchived.has(g.agentId);
        const isCollapsed = collapsed.has(g.agentId);
        if (hasFilter && visible.length === 0 && archived.length === 0) return null;
        return (
          <div key={g.agentId} className="ui-session-group">
            <button type="button" className="ui-session-group-head" onClick={() => toggleCollapsed(g.agentId)} title={isCollapsed ? '展开' : '收起'}>
              <AgentGlyph id={g.agentId} className="ui-agent-glyph" />
              <span className="ui-session-group-label">{g.agentName}</span>
              <span className="ui-session-group-caret">{isCollapsed ? <ChevronRightIcon /> : <ChevronDownIcon />}</span>
            </button>
            {!isCollapsed && (
              <div
                className="ui-session-group-list"
                data-dragging={drag?.agentId === g.agentId ? 'true' : 'false'}
                onDragOver={(e) => { if (drag?.agentId === g.agentId && e.target === e.currentTarget) { e.preventDefault(); setOverIndex(visible.length); } }}
                onDragLeave={(e) => { if (drag?.agentId === g.agentId && !e.currentTarget.contains(e.relatedTarget as Node)) setOverIndex(null); }}
                onDrop={(e) => { e.preventDefault(); handleDrop(g.agentId, overIndex ?? visible.length); }}
              >
                {visible.map((s, i) => (
                  <Fragment key={s.id}>
                    {drag?.agentId === g.agentId && overIndex === i && <div className="ui-drop-line" />}
                    {renderRow(s, g.agentId, visible)}
                  </Fragment>
                ))}
                {drag?.agentId === g.agentId && overIndex === visible.length && <div className="ui-drop-line" />}
                {archived.length > 0 && (
                  <button type="button" className="ui-session-archived-toggle" onClick={() => toggleArchiveGroup(g.agentId)}>
                    <ArchiveIcon /> {showArchived ? '收起归档' : `已归档 (${archived.length})`}
                  </button>
                )}
                {showArchived && archived.map((s) => renderRow(s, g.agentId, visible))}
              </div>
            )}
          </div>
        );
      })}
      {hasFilter && flatCount === 0 && <div className="ui-muted ui-session-empty">无匹配会话</div>}

      {menu && (
        <div ref={menuRef} className="ui-menu ui-menu--fixed ui-session-menu" role="menu" style={{ left: menu.x, top: menu.y }}>
          <button type="button" role="menuitem" className="ui-menu-item" onClick={() => { onPin?.(menu.agentId, menu.sessionId, !menu.pinned); setMenu(null); }}>
            <PinIcon /> <span>{menu.pinned ? '取消置顶' : '置顶'}</span>
          </button>
          <button type="button" role="menuitem" className="ui-menu-item" onClick={() => { onRename?.(menu.agentId, menu.sessionId); setMenu(null); }}>
            <span className="ui-menu-icon">✎</span> <span>重命名</span>
          </button>
          <button type="button" role="menuitem" className="ui-menu-item" onClick={() => { onArchive?.(menu.agentId, menu.sessionId, !menu.archived); setMenu(null); }}>
            {menu.archived ? <RestoreIcon /> : <ArchiveIcon />} <span>{menu.archived ? '撤销归档' : '归档'}</span>
          </button>
          <button type="button" role="menuitem" className="ui-menu-item" disabled={!menu.running} onClick={() => { onStop?.(menu.sessionId); setMenu(null); }}>
            <StopIcon /> <span>停止</span>
          </button>
          <button type="button" role="menuitem" className="ui-menu-item" disabled={!menu.running} onClick={() => { onRelease?.(menu.sessionId); setMenu(null); }}>
            <RestoreIcon /> <span>释放线程</span>
          </button>
          {onDelete && (
            <>
              <div className="ui-menu-sep" />
              <button type="button" role="menuitem" className="ui-menu-item ui-menu-item--danger" onClick={() => { onDelete(menu.agentId, menu.sessionId); setMenu(null); }}>
                <span className="ui-menu-icon">✕</span> <span>删除</span>
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
