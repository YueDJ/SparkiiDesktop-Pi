import { useRef, useState, type ReactNode } from 'react';
import { Menu, MenuItem } from '../primitives/Menu.js';

export interface WorkspaceButtonProps {
  path: string | null;
  testId: string;
  placement?: 'top' | 'bottom';
  children: ReactNode;
  onOpen(): void;
  onChoose(): void;
}

export function WorkspaceButton({
  path,
  testId,
  placement = 'bottom',
  children,
  onOpen,
  onChoose,
}: WorkspaceButtonProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <div ref={wrapperRef} className="ui-workspace-btn-wrap">
      <button
        type="button"
        className="ui-composer-ws-btn"
        data-testid={testId}
        title={path ? `${path}\n打开工作区或更换文件夹` : ''}
        disabled={!path}
        onClick={() => setOpen((value) => !value)}
      >
        {children}
      </button>
      {open && path && (
        <Menu open onClose={close} containerRef={wrapperRef} placement={placement}>
          <MenuItem
            label="打开工作区"
            testId="workspace-open"
            trailing=""
            onSelect={() => { close(); onOpen(); }}
          />
          <MenuItem
            label="更换工作区"
            testId="workspace-change"
            trailing=""
            onSelect={() => { close(); onChoose(); }}
          />
        </Menu>
      )}
    </div>
  );
}
