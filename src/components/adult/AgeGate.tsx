'use client';

import { motion, AnimatePresence } from 'framer-motion';
import { Sparkles, Lock } from 'lucide-react';

export function AgeGate({ onVerify, onDecline, hasSubscription, onGoToProfile }: { onVerify: () => void; onDecline: () => void; hasSubscription: boolean; onGoToProfile: () => void }) {
  return (
    <div className="animate-fade-in flex flex-col items-center justify-center py-12 sm:py-20 px-4">
      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: 'spring', stiffness: 200, damping: 20 }}
        className="relative max-w-md w-full"
      >
        <div className="absolute -inset-1 bg-gradient-to-r from-red-600/20 via-purple-600/20 to-pink-600/20 rounded-2xl blur-xl" />
        <div className="relative bg-[var(--card)] border border-red-500/30 rounded-2xl p-8 sm:p-10 text-center">
          <div className="w-20 h-20 mx-auto mb-6 rounded-full bg-red-500/15 flex items-center justify-center">
            <Lock className="w-10 h-10 text-red-400" />
          </div>
          <h1 className="text-2xl sm:text-3xl font-extrabold mb-3 bg-gradient-to-r from-red-400 via-pink-400 to-purple-400 bg-clip-text text-transparent">
            Контент 18+
          </h1>

          {!hasSubscription ? (
            <>
              <p className="text-[var(--muted-foreground)] mb-2 text-sm leading-relaxed">
                Доступ к контенту для взрослых по подписке.
              </p>
              <div className="bg-[var(--muted)] rounded-xl p-4 mb-6 text-left">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium">Подписка</span>
                  <span className="text-xs text-[var(--muted-foreground)]">от 83 ₽/мес</span>
                </div>
                <div className="space-y-1.5 text-xs text-[var(--muted-foreground)]">
                  <div className="flex items-center gap-2"><Sparkles className="w-3.5 h-3.5 text-[var(--primary)]" />Полная коллекция артов и видео</div>
                  <div className="flex items-center gap-2"><Sparkles className="w-3.5 h-3.5 text-[var(--primary)]" />Каталог 18+ аниме</div>
                  <div className="flex items-center gap-2"><Sparkles className="w-3.5 h-3.5 text-[var(--primary)]" />Без рекламы и ограничений</div>
                </div>
              </div>
              <div className="flex flex-col sm:flex-row gap-3">
                <button
                  onClick={onGoToProfile}
                  className="flex-1 px-6 py-3 rounded-xl font-semibold text-white bg-gradient-to-r from-[var(--primary)] to-[var(--accent)] hover:opacity-90 transition-all shadow-lg shadow-[var(--primary)]/25 active:scale-[0.98] flex items-center justify-center gap-2"
                >
                  <Sparkles className="w-4 h-4" />Оформить подписку
                </button>
                <button
                  onClick={onDecline}
                  className="flex-1 px-6 py-3 rounded-xl font-medium border border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--muted)] transition-colors"
                >
                  Назад
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="text-[var(--muted-foreground)] mb-2 text-sm leading-relaxed">
                Этот раздел содержит контент исключительно для взрослых.
              </p>
              <p className="text-[var(--muted-foreground)] mb-8 text-sm leading-relaxed">
                Нажимая кнопку ниже, вы подтверждаете, что вам исполнилось <span className="text-red-400 font-semibold">18 лет</span> и вы принимаете ответственность за просмотр данного контента.
              </p>
              <div className="flex flex-col sm:flex-row gap-3">
                <button
                  onClick={onVerify}
                  className="flex-1 px-6 py-3 rounded-xl font-semibold text-white bg-gradient-to-r from-red-600 to-pink-600 hover:from-red-500 hover:to-pink-500 transition-all shadow-lg shadow-red-500/25 hover:shadow-red-500/40 active:scale-[0.98]"
                >
                  Мне есть 18 лет
                </button>
                <button
                  onClick={onDecline}
                  className="flex-1 px-6 py-3 rounded-xl font-medium border border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--muted)] transition-colors"
                >
                  Вернуться назад
                </button>
              </div>
            </>
          )}
        </div>
      </motion.div>
    </div>
  );
}

/* ──────────────────── Enhanced 18+ Card ──────────────────── */
