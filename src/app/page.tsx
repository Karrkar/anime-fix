import App from '@/components/App';
import { getHomeInitialData } from '@/lib/home-data';

// ISR: главная перегенерируется в фоне не чаще, чем раз в 5 минут —
// HTML всегда несёт актуальные полки; клиентский рефетч в HomePage
// подтягивает самые свежие данные в долгоживущих вкладках.
export const revalidate = 300;

// Серверный компонент: полки каталога кладутся прямо в HTML (SSR),
// поэтому контент главной виден до загрузки JS. App (клиентский) принимает
// данные опционально — без БД главная работает как раньше (скелетоны + fetch).
export default async function Page() {
  const initialHome = await getHomeInitialData();
  return <App initialHome={initialHome} />;
}
