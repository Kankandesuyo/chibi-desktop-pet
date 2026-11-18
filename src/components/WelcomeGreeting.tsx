import { useEffect, useState } from 'react';
import { useT } from '../i18n';

export function WelcomeGreeting({ callMe, displayName }: { callMe: string; displayName: string }) {
  const t = useT();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: number;
    function tick() {
      const date = new Date();
      setNow(date);
      window.clearTimeout(timer);
      timer = window.setTimeout(tick, 60000 - date.getSeconds() * 1000 - date.getMilliseconds());
    }
    tick();
    window.addEventListener('focus', tick);
    return () => { window.clearTimeout(timer); window.removeEventListener('focus', tick); };
  }, []);
  const hour = now.getHours();
  const greeting = hour < 5 || hour >= 18 ? t('晚上好') : hour < 11 ? t('早上好') : hour < 14 ? t('中午好') : t('下午好');
  const name = callMe.trim() || displayName.trim();
  return <h2>{greeting}{name && t('，')}{name}</h2>;
}
