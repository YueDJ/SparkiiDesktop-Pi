import { useEffect, useRef, useState } from 'react';

export function Countdown(props: { until: number; onExpire?(): void; className?: string }) {
  const fired = useRef(false);
  const [left, setLeft] = useState(() => Math.max(0, Math.ceil((props.until - Date.now()) / 1000)));

  useEffect(() => {
    const tick = () => {
      const s = Math.max(0, Math.ceil((props.until - Date.now()) / 1000));
      setLeft(s);
      if (s <= 0 && !fired.current) {
        fired.current = true;
        props.onExpire?.();
      }
    };
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [props.until, props.onExpire]);

  return <span className={props.className}>{left}s</span>;
}
