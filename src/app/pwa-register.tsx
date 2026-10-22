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
      // Страница загружалась уже ПОД управлением SW? Если да — новый SW,
      // пришедший с деплоем (skipWaiting + clients.claim), означает:
      // кэш и чанки этой вкладки устарели. Один раз за сессию перезагружаем
      // страницу, чтобы вкладка «самолечилась» без участия пользователя.
      // Первый заход (контроллера не было) пропускаем — иначе лишний reload.
      const hadController = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.register('/sw.js').then(() => {
        if (!hadController) return;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          try {
            if (sessionStorage.getItem('ap_sw_healed')) return;
            sessionStorage.setItem('ap_sw_healed', '1');
            window.location.reload();
          } catch { /* sessionStorage недоступен — просто не лечим */ }
        });
      }).catch(() => {
        /* тихо: сайт полностью работает и без SW */
      });
    }, 1500);
    return () => clearTimeout(t);
  }, []);

  return null;
}
