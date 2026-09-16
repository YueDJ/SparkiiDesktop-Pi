import { useEffect, useRef } from 'react';

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function useFocusScope<T extends HTMLElement>(open: boolean, onClose: () => void) {
  const ref = useRef<T | null>(null);
  const onCloseRef = useRef(onClose);
  const previousRef = useRef<HTMLElement | null>(null);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    previousRef.current = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusables = node
      ? Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.hasAttribute('disabled'))
      : [];

    const current = focusables.find((el) => el.hasAttribute('data-current'));
    (current ?? focusables[0] ?? node)?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }

      if (focusables.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        event.preventDefault();
        const active = document.activeElement as HTMLElement | null;
        let idx = active ? focusables.indexOf(active) : -1;
        if (idx < 0) idx = event.key === 'ArrowDown' ? -1 : 0;
        const next = event.key === 'ArrowDown'
          ? focusables[(idx + 1) % focusables.length]
          : focusables[(idx - 1 + focusables.length) % focusables.length];
        next.focus();
        return;
      }

      if (event.key !== 'Tab' || focusables.length === 0) return;

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      previousRef.current?.focus?.();
    };
  }, [open]);

  return ref;
}
