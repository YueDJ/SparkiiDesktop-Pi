import { useEffect, useRef, useState } from 'react';
export function Countdown({ until, onExpire, className = '' }: { until: number; onExpire?(): void; className?: string }) {
  const fired = useRef(false);
  const [left, setLeft] = useState(() => Math.max(0, Math.ceil((until - Date.now()) / 1000)));
  useEffect(() => {
    const tick = () => {
      const s = Math.max(0, Math.ceil((until - Date.now()) / 1000));
      setLeft(s);
      if (s <= 0 && !fired.current) { fired.current = true; onExpire?.(); }
    };
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [until, onExpire]);
  return <span className={`ui-countdown ${className}`}>{left}s</span>;
}
