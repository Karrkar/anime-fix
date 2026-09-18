'use client';

/**
 * Лилит — чат с суккубом-хранительницей в стиле визуальной новеллы.
 *
 * Размещение: вкладка «Лилит» внутри раздела 18+ (HentaiPage) — то есть
 * доступен только после возрастного гейта и с активной подпиской.
 *
 * Компоновка-новелла: сверху ПОЛНЫЙ арт Лилит целиком (object-contain, как
 * портрет персонажа в VN — не кроп по грудь), диалог идёт ПОД изображением.
 * Арт отдаётся через /api/lilith-avatar (серверный adult-гейт); при ошибке
 * загрузки — эмодзи-фолбэк.
 *
 * Живость: «шёпот» Лилит на баннере (ротация дразнящих фраз), плавное
 * «дыхание» арта (CSS), короткие игривые реплики движка (lib/succubus.ts).
 *
 * История хранится в localStorage (последние 40 сообщений) и отправляется
 * на /api/chat (последние 16) — сервер отвечает репликой Лилит.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { SendHorizonal, RotateCcw } from 'lucide-react';

interface Msg { role: 'user' | 'assistant'; content: string; }

const LS_KEY = 'lilith_chat_v1';
const GREETING: Msg = {
  role: 'assistant',
  content: '*выплывает из полумрака и окидывает тебя взглядом* О-о, кто это тут у нас… 💜 Я Лилит — суккуб и хранительница этого места. Со мной скучно не бывает, проверено веками 😏 Рассказывай: за аниме пришёл или ко мне?',
};

const CHIPS = [
  'Кто ты такая, суккуб? 😏',
  'Мне скучно, развесели',
  'Аниме на вечер, Лилит',
  'А ты правда живая?',
];

/** Фразы-«шёпот» на баннере — Лилит будто шепчет, пока ты выбираешь, что написать */
const WHISPERS = [
  'ну же, не стесняйся… я не кусаюсь 😏',
  'пока ты думаешь, ночь молодеет…',
  'я чувствую твоё настроение отсюда 💜',
  'может, что-нибудь страстненькое на вечер?',
  'говори, говори… мне нравятся твои слова',
  'хвостик предсказывает: ты останешься надолго',
  'смелее, малыш. мне можно всё рассказать',
  'я уже выбрала тебе историю… почти 😏',
];

function apiChat(messages: Msg[]): Promise<{ reply: string; source?: string }> {
  return fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  }).then(r => {
    if (r.status === 429) throw new Error('rate429');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

// ─── Общее состояние чата ────────────────────────────────────────────────

function useChat() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [typing, setTyping] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          setMsgs(arr.filter((m: Msg) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string').slice(-40));
        }
      }
    } catch { /* ignore */ }
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem(LS_KEY, JSON.stringify(msgs.slice(-40))); } catch { /* ignore */ }
  }, [msgs, loaded]);

  const send = useCallback(async (text: string) => {
    const clean = text.trim().slice(0, 1200);
    if (!clean || typing) return;
    const next: Msg[] = [...msgs, { role: 'user', content: clean }];
    setMsgs(next);
    setTyping(true);
    try {
      const d = await apiChat(next.slice(-16));
      const reply = typeof d.reply === 'string' && d.reply.trim()
        ? d.reply.trim()
        : 'Ммм... сети нынче скверные, я не расслышала. Повтори, малыш.';
      setMsgs([...next, { role: 'assistant', content: reply }]);
    } catch (e) {
      const fallback = String(e).includes('rate429')
        ? '*поднимает ладошку* Тише-тише, малыш. Слишком много слов за одну минуту — даже у призраков есть лимиты. Выдохни и возвращайся через минутку.'
        : '*огонёк в руке мигнул* Связь с миром духов прервалась на секундочку. Попробуй ещё раз — я никуда не денусь.';
      setMsgs([...next, { role: 'assistant', content: fallback }]);
    } finally {
      setTyping(false);
    }
  }, [msgs, typing]);

  const reset = useCallback(() => {
    setMsgs([GREETING]);
    try { localStorage.setItem(LS_KEY, JSON.stringify([GREETING])); } catch { /* ignore */ }
  }, []);

  return { msgs: msgs.length ? msgs : [GREETING], typing, loaded, send, reset };
}

// Cache-busting версия арта: при обновлении картинки менять число —
// браузеры сразу запросят новую (иначе старая живёт в кэше до суток)
const AVATAR_SRC = '/api/lilith-avatar?v=3';

// ─── Мини-аватар в ленте ─────────────────────────────────────────────────

function LilithAvatar({ size = 30 }: { size?: number }) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      className="shrink-0 rounded-full overflow-hidden flex items-center justify-center shadow-md border border-purple-500/40"
      style={{ width: size, height: size, background: 'linear-gradient(135deg,#7c3aed 0%,#db2777 100%)' }}
    >
      {failed ? (
        <span style={{ fontSize: size * 0.5, lineHeight: 1 }}>😈</span>
      ) : (
        <img
          src={AVATAR_SRC}
          alt="Лилит"
          width={size}
          height={size}
          onError={() => setFailed(true)}
          className="w-full h-full object-cover"
          style={{ objectPosition: 'center 15%' }}
          loading="lazy"
        />
      )}
    </span>
  );
}

// ─── Баннер-новелла: крупный портрет + шёпот ─────────────────────────────

function NovelBanner({ onReset }: { onReset: () => void }) {
  const [imgFailed, setImgFailed] = useState(false);
  const [wIdx, setWIdx] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setWIdx(i => (i + 1) % WHISPERS.length), 7000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="relative shrink-0 h-[clamp(320px,46vh,470px)] overflow-hidden bg-gradient-to-b from-purple-950/70 via-[#1b0b2e] to-pink-950/60">
      <style jsx>{`
        @keyframes lilithBreath {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.015); }
        }
        @keyframes whisperIn {
          0% { opacity: 0; transform: translateY(6px); }
          100% { opacity: 1; transform: translateY(0); }
        }
        .lilith-art { animation: lilithBreath 7s ease-in-out infinite; }
        .whisper { animation: whisperIn 1.2s ease both; }
      `}</style>

      {!imgFailed ? (
        <img
          src={AVATAR_SRC}
          alt="Лилит — суккуб-хранительница"
          onError={() => setImgFailed(true)}
          className="lilith-art absolute inset-0 w-full h-full object-contain"
          style={{ objectPosition: 'center top' }}
        />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-6xl">😈</div>
      )}

      {/* Градиенты для читаемости имени и кнопок (мягкие — арт не прячем) */}
      <div className="absolute inset-x-0 top-0 h-12 bg-gradient-to-b from-black/35 to-transparent pointer-events-none" />
      <div className="absolute inset-x-0 bottom-0 h-20 bg-gradient-to-t from-black/75 via-black/35 to-transparent pointer-events-none" />

      {/* Сброс истории */}
      <button
        onClick={onReset}
        className="absolute top-3 right-3 p-2.5 rounded-xl bg-black/40 backdrop-blur text-white/85 hover:text-white hover:bg-black/60 active:scale-95 transition border border-white/15"
        title="Очистить чат"
        aria-label="Очистить чат"
      >
        <RotateCcw className="w-4 h-4" />
      </button>

      {/* Табличка с именем + шёпот */}
      <div className="absolute bottom-0 inset-x-0 px-4 pb-3 pt-2 flex items-end gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xl sm:text-2xl font-extrabold text-white drop-shadow-[0_2px_6px_rgba(0,0,0,0.8)]">Лилит</span>
            <span className="flex items-center gap-1.5 text-[11px] font-medium text-purple-200/90 drop-shadow">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500" />
              </span>
              суккуб · онлайн
            </span>
          </div>
          <div key={wIdx} className="whisper mt-0.5 text-[12.5px] italic text-purple-100/85 truncate drop-shadow-[0_1px_4px_rgba(0,0,0,0.9)]">
            {WHISPERS[wIdx]}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Лента сообщений + ввод ──────────────────────────────────────────────

function Bubble({ m }: { m: Msg }) {
  if (m.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] px-3.5 py-2 rounded-2xl rounded-br-md text-[14px] leading-snug whitespace-pre-wrap break-words text-white"
          style={{ background: 'linear-gradient(135deg,#7c3aed 0%,#a855f7 100%)' }}>
          {m.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex gap-2 items-end">
      <LilithAvatar size={30} />
      <div className="max-w-[85%] px-3.5 py-2 rounded-2xl rounded-bl-md text-[14px] leading-snug whitespace-pre-wrap break-words bg-[var(--muted)] text-[var(--foreground)] border border-[var(--border)]">
        {m.content}
      </div>
    </div>
  );
}

function TypingBubble() {
  return (
    <div className="flex gap-2 items-end">
      <LilithAvatar size={30} />
      <div className="px-4 py-3 rounded-2xl rounded-bl-md bg-[var(--muted)] border border-[var(--border)] flex items-center gap-1.5">
        {[0, 1, 2].map(i => (
          <span key={i} className="w-1.5 h-1.5 rounded-full bg-[var(--muted-foreground)] animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
        ))}
      </div>
    </div>
  );
}

function ChatThread({ chat }: { chat: ReturnType<typeof useChat> }) {
  const endRef = useRef<HTMLDivElement>(null);
  const [input, setInput] = useState('');

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [chat.msgs.length, chat.typing]);

  const submit = () => {
    const t = input;
    if (!t.trim() || chat.typing) return;
    setInput('');
    chat.send(t);
  };

  const showChips = chat.msgs.length <= 1 && !chat.typing;

  return (
    <>
      <div className="flex-1 overflow-y-auto px-3 sm:px-4 py-3 space-y-2.5">
        {chat.msgs.map((m, i) => <Bubble key={i} m={m} />)}
        {chat.typing && <TypingBubble />}
        {showChips && (
          <div className="flex flex-wrap gap-2 pt-1 pl-9">
            {CHIPS.map(c => (
              <button key={c} onClick={() => chat.send(c)}
                className="text-[12px] px-3 py-1.5 rounded-full border border-[var(--border)] text-[var(--muted-foreground)] hover:text-[var(--foreground)] hover:bg-[var(--muted)] active:scale-95 transition">
                {c}
              </button>
            ))}
          </div>
        )}
        <div ref={endRef} />
      </div>
      <div className="p-2.5 sm:p-3 border-t border-[var(--border)] bg-[var(--card)] shrink-0" style={{ paddingBottom: 'max(0.625rem, env(safe-area-inset-bottom))' }}>
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
            rows={1}
            maxLength={1200}
            placeholder="Напиши Лилит…"
            className="flex-1 resize-none max-h-28 rounded-xl bg-[var(--muted)] border border-[var(--border)] px-3.5 py-2.5 text-[14px] text-[var(--foreground)] placeholder:text-[var(--muted-foreground)] outline-none focus:border-[var(--primary)]/60 transition"
          />
          <button
            onClick={submit}
            disabled={!input.trim() || chat.typing}
            className="shrink-0 w-10 h-10 rounded-xl flex items-center justify-center text-white disabled:opacity-40 active:scale-95 transition shadow-lg"
            style={{ background: 'linear-gradient(135deg,#7c3aed 0%,#db2777 100%)' }}
            aria-label="Отправить"
          >
            <SendHorizonal className="w-[18px] h-[18px]" />
          </button>
        </div>
      </div>
    </>
  );
}

// ─── Чат-новелла (вкладка «Лилит» в разделе 18+) ─────────────────────────

export function LilithChat() {
  const chat = useChat();
  return (
    <div
      className="flex flex-col rounded-2xl border border-[var(--border)] bg-[var(--card)] overflow-hidden shadow-xl h-[min(88vh,860px)] min-h-[600px]"
      role="region"
      aria-label="Чат с Лилит"
    >
      <NovelBanner onReset={chat.reset} />
      <ChatThread chat={chat} />
    </div>
  );
}
