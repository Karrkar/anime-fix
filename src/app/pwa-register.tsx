'use client';

import { useEffect } from 'react';

/**
 * Регистрация service worker'а (PWA). Компонент ничего не рендерит —
 * только ставит SW в очередь регистрации после монтирования, исключительно
 * в проде и в браузерах с поддержкой (регистрация в dev ломает HMR).
 */
export default function PwaRegister() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;
    if (process.env.NODE_ENV !== 'production') return;

    // Небольшая задержка: SW не должен конкурировать с первым рендером страницы
    const t = setTimeout(() => {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        /* тихо: сайт полностью работает и без SW */
      });
    }, 1500);
    return () => clearTimeout(t);
  }, []);

  return null;
}
