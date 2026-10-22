'use client';

import { useEffect } from 'react';

/**
 * Регистрация service worker'а (PWA) + АКТИВНАЯ АВТОПОЧИНКА.
 *
 * Проблема, которую решает этот файл: домен стоит за Cloudflare, который
 * кэширует /sw.js до 4 часов. Из-за этого новый SW (с механизмом лечения
 * застрявших вкладок) не мог добраться до браузера — старый SW продолжал
 * держать вкладку на мёртвых чанках прошлой сборки: главная пустая,
 * вкладки не кликаются. Прямой адрес *.vercel.app работал, потому что на
 * нём вообще нет service worker'а.
 *
 * Решение (3 слоя защиты):
 *  1. ВЕРСИОНИРОВАННЫЙ URL регистрации: /sw.js?b=<BUILD_ID> — уникален для
 *     каждого деплоя → Cloudflare всегда отдаёт его мимо кэша (MISS) →
 *     браузер получает актуальный файл автопочинки мгновенно.
 *  2. Регистрация с ДРУГИМ URL на том же scope автоматически ЗАМЕНЯЕТ старую
 *     регистрацию — залипший SW ap-v1/v2/v3 больше не контролирует страницу.
 *  3. updateViaCache: 'none' — браузер никогда не берёт SW-скрипт из
 *     HTTP-кэша при проверках обновлений (только сеть).
 *
 * Плюс: перед регистрацией вычищаются ВСЕ посторонние SW-регистрации
 * (getRegistrations → unregister), даже если они остались от старых
 * версий с другими URL.
 */
export default function PwaRegister() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;
    if (process.env.NODE_ENV !== 'production') return;

    // Уникальный URL этой сборки: Cloudflare не имеет его в кэше.
    const buildId = process.env.NEXT_PUBLIC_BUILD_ID || '';
    const swUrl = buildId ? `/sw.js?b=${buildId}` : '/sw.js';

    // Небольшая задержка: SW не должен конкурировать с первым рендером страницы
    const t = setTimeout(async () => {
      try {
        // Страница грузилась уже ПОД управлением SW? Если да — смена
        // контроллера (новый SW из деплоя) означает: кэш и чанки этой вкладки
        // устарели. Один раз за сессию перезагружаем страницу — вкладка
        // «самолечится» без участия пользователя. Первый заход (контроллера
        // не было) пропускаем — иначе лишний reload.
        const hadController = !!navigator.serviceWorker.controller;

        // 1) Вычищаем ВСЕ регистрации, не соответствующие текущей сборке.
        //    Это убивает залипшие SW старых версий, которые месяцами держали
        //    вкладку на мёртвых чанках (кэш-first на /_next/static/*).
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.allSettled(
          regs
            .filter((r) => {
              const activeUrl = r.active?.scriptURL || r.installing?.scriptURL || r.waiting?.scriptURL || '';
              return activeUrl && !activeUrl.includes(`sw.js?b=${buildId}`);
            })
            .map((r) => r.unregister())
        );

        // 2) Регистрируем SW под версионированным URL (кэш CF обходится).
        //    Слушатель controllerchange ставим ДО регистрации: skipWaiting()
        //    в новом SW активирует его сразу, событие может прийти мгновенно.
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          try {
            if (sessionStorage.getItem('ap_sw_healed')) return;
            sessionStorage.setItem('ap_sw_healed', '1');
            window.location.reload();
          } catch { /* sessionStorage недоступен — просто не лечим */ }
        });

        await navigator.serviceWorker.register(swUrl, {
          scope: '/',
          updateViaCache: 'none', // SW-скрипт никогда из HTTP-кэша
        });

        // Если старый SW контролировал страницу, а новый уже WAITING
        // (не активировался сам) — подталкиваем. Обычно skipWaiting в install
        // решает это, но на всякий случай.
        if (hadController) {
          const reg = await navigator.serviceWorker.getRegistration();
          if (reg?.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        }
      } catch {
        /* тихо: сайт полностью работает и без SW */
      }
    }, 1500);
    return () => clearTimeout(t);
  }, []);

  return null;
}
