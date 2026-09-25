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
 * Живость: «шёпот» Лилит на баннере (ротация дразнящих фраз, подстраивается
 * под настроение беседы), плавное «дыхание» арта (CSS), короткие игривые
 * реплики движка (lib/succubus.ts), пауза «набирает текст» перед показом
 * ответа и быстрые ответы-чипы, контекстные к последней реплике.
 *
 * Память: профиль собеседника (имя, любимые жанры/тайтлы) живёт в
 * localStorage (lilith_profile_v1), шлётся с каждым запросом и пополняется
 * дельтой из ответа сервера (profileDelta) — Лилит помнит вас и после
 * сброса чата: суккубы не признают забвения.
 *
 * История хранится в localStorage (последние 40 сообщений) и отправляется
 * на /api/chat (последние 16) — сервер отвечает репликой Лилит.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { SendHorizonal, RotateCcw } from 'lucide-react';
import { extractName, detectGenre, sanitizeProfile, type LilithProfile } from '@/lib/succubus';

interface Msg { role: 'user' | 'assistant'; content: string; }

const LS_KEY = 'lilith_chat_v1';
const LS_PROFILE = 'lilith_profile_v1';

const GREETING_FIRST: Msg = {
  role: 'assistant',
  content: '*выплывает из полумрака и окидывает тебя взглядом* О-о, кто это тут у нас… 💜 Я Лилит — суккуб и хранительница этого места. Со мной скучно не бывает, проверено веками 😏 Рассказывай: за аниме пришёл или ко мне?',
};

/** Приветствие зависит от памяти: знакомца Лилит встречает по имени */
function greetingFor(p: LilithProfile): Msg {
  if (p.name) {
    return {
      role: 'assistant',
      content: `*выплывает из полумрака и улыбается одним уголком губ* О-о, ${p.name}… а я тебя помню 😏 С возвращением, малыш. Ночь без тебя была неполной — рассказывай, что случилось, пока меня не было? 💜`,
    };
  }
  return GREETING_FIRST;
}

// ─── Профиль-память (localStorage, переживает сброс чата) ────────────────

function loadProfile(): LilithProfile {
  try {
    const raw = localStorage.getItem(LS_PROFILE);
    if (raw) return sanitizeProfile(JSON.parse(raw));
  } catch { /* ignore */ }
  return {};
}

function saveProfile(p: LilithProfile) {
  try { localStorage.setItem(LS_PROFILE, JSON.stringify(p)); } catch { /* ignore */ }
}

/** Влить серверную дельту (имя/жанр/тайтл) в профиль с дедупликацией */
function mergeProfile(base: LilithProfile, delta: unknown): LilithProfile {
  const d = sanitizeProfile(delta);
  const merged: LilithProfile = { ...base };
  if (d.name) merged.name = d.name;
  const push = (arr?: string[], add?: string[], cap = 6): string[] =>
    Array.from(new Set([...(arr || []), ...(add || [])])).slice(0, cap);
  if (d.favGenres?.length) merged.favGenres = push(merged.favGenres, d.favGenres, 4);
  if (d.favTitles?.length) merged.favTitles = push(merged.favTitles, d.favTitles);
  return merged;
}

// ─── Настроение беседы (бейдж и шёпот на баннере) ────────────────────────

type Mood = 'playful' | 'low' | 'flirty';

function moodOf(msgs: Msg[]): Mood {
  const lastUser = [...msgs].reverse().find(m => m.role === 'user')?.content.toLowerCase() || '';
  if (/(устал|вымотал|груст|тоск|обид|одинок|стресс|болит|тяжело|плохо|не могу)/.test(lastUser)) return 'low';
  if (/(красив|нравишься|люблю тебя|поцел|свидан|хочу тебя|страстн|флирт)/.test(lastUser)) return 'flirty';
  return 'playful';
}

const MOOD_LABEL: Record<Mood, string> = { playful: 'игривая', low: 'заботливая', flirty: 'дразнящая' };

const CHIPS = [
  'Кто ты такая, суккуб? 😏',
  'Мне скучно, развесели',
  'Аниме на вечер, Лилит',
  'А ты правда живая?',
];

// Контекстные быстрые ответы — подстраиваются под последнюю реплику Лилит
const CHIPS_AFTER_REC = ['А что-нибудь полегче?', 'А поострее 😏', 'Спасибо, красотка 💜'];
const CHIPS_AFTER_CARE = ['Мне уже легче 💜', 'Дай что-нибудь уютное на вечер', 'Просто выговорился'];
const CHIPS_AFTER_TEASE = ['Ты загадочная 😏', 'Ладно-ладно, сдаюсь', 'Расскажу о себе'];
const CHIPS_AFTER_WHO = ['А что ты умеешь?', 'Сколько тебе веков?', 'Подбери мне аниме'];

function pickChips(msgs: Msg[]): string[] {
  const lastA = [...msgs].reverse().find(m => m.role === 'assistant')?.content || '';
  const t = lastA.toLowerCase();
  if (t.includes('«') && /(подаю|шорт-лист|жемчужин|наудачу|глянь|проверенное|порцию)/.test(t)) return CHIPS_AFTER_REC;
  if (/(устал|груст|слушаю|дверь открыта|на душе|без дразнилок|в темноте)/.test(t)) return CHIPS_AFTER_CARE;
  if (/(соблазн|интрига|спешка|изящн|комплимент|развлеки меня)/.test(t)) return CHIPS_AFTER_TEASE;
  if (/(хранительниц|суккуб по душе|лучшее, что случится)/.test(t)) return CHIPS_AFTER_WHO;
  return CHIPS;
}

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
const WHISPERS_CARE = [
  'я рядом… никуда не торопись 💜',
  'расскажешь мне всё — я умею слушать',
  'темнота здесь тёплая. оставайся сколько нужно',
  'обопрись на меня, смертный. мне не тяжело',
];
const WHISPERS_TEASE = [
  'ну-ну, полегче, горячий 😏',
  'я вижу, куда ты клонишь… и мне нравится',
  'соблазнять — моя работа, не забывай 😈',
  'осторожнее со словами: я запоминаю всё',
];

function apiChat(messages: Msg[], profile: LilithProfile): Promise<{ reply: string; source?: string; profileDelta?: unknown }> {
  return fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, profile }),
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
  const profileRef = useRef<LilithProfile>({});

  useEffect(() => {
    // Профиль грузится первым: от него зависит приветствие знакомца
    const p = loadProfile();
    profileRef.current = p;
    let stored: Msg[] | null = null;
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length) {
          stored = arr
            .filter((m: Msg) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
            .slice(-40);
        }
      }
    } catch { /* ignore */ }
    setMsgs(stored && stored.length ? stored : [greetingFor(p)]);
    setLoaded(true);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    try { localStorage.setItem(LS_KEY, JSON.stringify(msgs.slice(-40))); } catch { /* ignore */ }
  }, [msgs, loaded]);

  const send = useCallback(async (text: string) => {
    const clean = text.trim().slice(0, 1200);
    if (!clean || typing) return;

    // Профиль пополняется прямо из реплики (имя/любимый жанр)
    const updated = { ...profileRef.current };
    const n = extractName(clean);
    if (n) updated.name = n;
    const g = detectGenre(clean);
    if (g && /(любл|люблю|нрав|обожа|заход|кайф|огонь)/.test(clean.toLowerCase())) {
      updated.favGenres = Array.from(new Set([...(updated.favGenres || []), g])).slice(0, 4);
    }
    profileRef.current = updated;
    saveProfile(updated);

    const next: Msg[] = [...msgs, { role: 'user', content: clean }];
    setMsgs(next);
    setTyping(true);
    try {
      const d = await apiChat(next.slice(-16), updated);
      const reply = typeof d.reply === 'string' && d.reply.trim()
        ? d.reply.trim()
        : 'Ммм... сети нынче скверные, я не расслышала. Повтори, малыш.';

      // Пауза «набирает текст»: реплика приходит не мгновенно — так живее
      const think = Math.min(1500, 300 + reply.length * 18);
      await new Promise(res => setTimeout(res, think));

      // Сервер мог вынести из реплики имя/жанр/тайтл — вливаем дельту в профиль
      if (d.profileDelta && typeof d.profileDelta === 'object') {
        const merged = mergeProfile(profileRef.current, d.profileDelta);
        profileRef.current = merged;
        saveProfile(merged);
      }
      setMsgs([...next, { role: 'assistant', content: reply }]);
    } catch (e) {
      const fallback = String(e).includes('rate429')
        ? '*поднимает ладошку* Тише-тише, малыш. Слишком много слов за одну минуту — даже у призраков есть лимиты. Выдохни и возвращайся через минутку.'
        : '*огонёк в руке мигнул* Связь с миром духов прервалась на секундочку. Попробуй ещё раз — я никуда не денусь.';
      await new Promise(res => setTimeout(res, 600));
      setMsgs([...next, { role: 'assistant', content: fallback }]);
    } finally {
      setTyping(false);
    }
  }, [msgs, typing]);

  // Сброс = новая беседа, но НЕ забвение: профиль (имя/вкусы) Лилит хранит
  const reset = useCallback(() => {
    const g = greetingFor(profileRef.current);
    setMsgs([g]);
    try { localStorage.setItem(LS_KEY, JSON.stringify([g])); } catch { /* ignore */ }
  }, []);

  return { msgs: msgs.length ? msgs : [greetingFor(profileRef.current)], typing, loaded, send, reset };
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

function NovelBanner({ onReset, mood }: { onReset: () => void; mood: Mood }) {
  const [imgFailed, setImgFailed] = useState(false);
  const [wIdx, setWIdx] = useState(0);
  // Шёпот подстраивается под настроение беседы
  const whispers = mood === 'low' ? WHISPERS_CARE : mood === 'flirty' ? WHISPERS_TEASE : WHISPERS;

  useEffect(() => {
    setWIdx(0);
    const t = setInterval(() => setWIdx(i => (i + 1) % whispers.length), 7000);
    return () => clearInterval(t);
  }, [whispers]);

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
        title="Начать заново — Лилит вас запомнит"
        aria-label="Начать разговор заново"
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
              суккуб · {MOOD_LABEL[mood]}
            </span>
          </div>
          <div key={wIdx} className="whisper mt-0.5 text-[12.5px] italic text-purple-100/85 truncate drop-shadow-[0_1px_4px_rgba(0,0,0,0.9)]">
            {whispers[wIdx]}
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

  // Быстрые ответы подстраиваются под последнюю реплику и не мешают печати
  const showChips = !chat.typing && chat.msgs.length >= 1;
  const chips = pickChips(chat.msgs);

  return (
    <>
      <div className="flex-1 overflow-y-auto px-3 sm:px-4 py-3 space-y-2.5">
        {chat.msgs.map((m, i) => <Bubble key={i} m={m} />)}
        {chat.typing && <TypingBubble />}
        {showChips && (
          <div className="flex flex-wrap gap-2 pt-1 pl-9">
            {chips.map(c => (
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
      <NovelBanner onReset={chat.reset} mood={moodOf(chat.msgs)} />
      <ChatThread chat={chat} />
    </div>
  );
}
