import { useEffect, useState } from 'react';
import { SelectMenu, SettingsPageHeader, SettingsRow, SettingsSection } from '@sparkii/ui';
import { readSavedTheme, setTheme } from './theme.js';

/** 主题是即时生效的本机偏好：与顶栏开关共用同一份 localStorage 与 dark class。 */
export function SettingsAppearancePane() {
  const [theme, setThemeState] = useState<'light' | 'dark'>(() => readSavedTheme());

  useEffect(() => {
    const target = document.documentElement;
    const sync = () => setThemeState(target.classList.contains('dark') ? 'dark' : 'light');
    const observer = new MutationObserver(sync);
    observer.observe(target, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const apply = (next: string) => {
    const dark = next === 'dark';
    setThemeState(dark ? 'dark' : 'light');
    setTheme(dark);
  };

  return (
    <>
      <SettingsPageHeader title="外观" />
      <SettingsSection>
        <SettingsRow label="主题" description="立即生效，并记住你的选择。">
          <SelectMenu
            aria-label="主题"
            value={theme}
            options={[{ value: 'light', label: '浅色' }, { value: 'dark', label: '深色' }]}
            onChange={apply}
          />
        </SettingsRow>
      </SettingsSection>
    </>
  );
}
