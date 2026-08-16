import { dailyStats, hourlyOrders } from '@/data/seed';
import type { Order } from '@/types';

export interface DashboardStats {
  todayRevenue: number;
  todayOrders: number;
  todayNew: number;
  prevRevenue: number;
  prevOrders: number;
  conversion: number;
  aov: number;
  gmv: number;
}

function startOfToday(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function computeStats(orders: Order[]): DashboardStats {
  const todayStart = startOfToday();
  const yesterdayStart = todayStart - 86400000;
  const completed = orders.filter((o) => o.status === 'completed');
  const todayCompleted = completed.filter((o) => o.completedAt && o.completedAt >= todayStart);
  const todayAll = orders.filter((o) => o.createdAt >= todayStart);
  const yesterday = completed.filter(
    (o) => o.completedAt && o.completedAt >= yesterdayStart && o.completedAt < todayStart,
  );
  const todayRevenue = todayCompleted.reduce((s, o) => s + o.total, 0);
  const prevRevenue = yesterday.reduce((s, o) => s + o.total, 0);
  const gmv = completed.reduce((s, o) => s + o.total, 0);
  const aov = todayCompleted.length ? todayRevenue / todayCompleted.length : 0;
  return {
    todayRevenue: Math.round(todayRevenue * 100) / 100,
    todayOrders: todayAll.length,
    todayNew: orders.filter((o) => o.status === 'new').length,
    prevRevenue: Math.round(prevRevenue * 100) / 100,
    prevOrders: yesterday.length,
    conversion: 3.7,
    aov: Math.round(aov),
    gmv: Math.round(gmv * 100) / 100,
  };
}

export function revenueTrend(orders: Order[], range: 'day' | 'week' | 'month'): { label: string; value: number }[] {
  const todayStart = startOfToday();
  const points = range === 'day' ? 24 : range === 'week' ? 7 : 30;
  const interval = range === 'day' ? 3600000 : 86400000;
  const start = todayStart - (points - 1) * interval;
  const buckets = new Array(points).fill(0);
  orders
    .filter((o) => o.status === 'completed' && o.completedAt)
    .forEach((o) => {
      const idx = Math.floor(((o.completedAt as number) - start) / interval);
      if (idx >= 0 && idx < points) buckets[idx] += o.total;
    });
  return buckets.map((v, i) => ({
    label: range === 'day' ? `${String(i).padStart(2, '0')}:00` : `Day ${i + 1}`,
    value: Math.round(v),
  }));
}

export function orderByHour(orders: Order[]) {
  return hourlyOrders(orders);
}

export function weeklyTrend(orders: Order[]) {
  return dailyStats(orders, 7);
}

export function topDishes(orders: Order[]): { name: string; emoji: string; sold: number; revenue: number }[] {
  const map = new Map<string, { name: string; emoji: string; sold: number; revenue: number }>();
  orders
    .filter((o) => o.status === 'completed')
    .forEach((o) =>
      o.items.forEach((i) => {
        const cur = map.get(i.name) || { name: i.name, emoji: i.emoji, sold: 0, revenue: 0 };
        cur.sold += i.qty;
        cur.revenue += i.price * i.qty;
        map.set(i.name, cur);
      }),
    );
  return [...map.values()].sort((a, b) => b.sold - a.sold).slice(0, 6);
}