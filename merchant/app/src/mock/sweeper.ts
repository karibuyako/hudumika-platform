import type { CampaignDto, ClosureProtection, DianjinCampaign, MerchantDevice, NotificationDto, OrderDto, PrintJob, Promotion, Refund, Reservation, RiskEvent, StoreServer, Withdrawal } from '@/api/types';
import { db, uid } from '@/mock/db';
import { emit } from '@/mock/events';
import { refundPayment, performAccept } from '@/mock/handlers/orders';
import { logStoreOp } from '@/mock/handlers/store-ops';
import { audit } from '@/mock/security';

/* Server-side sweeper jobs. Node-safe: no react-native imports so tests can
 * import this module directly and drive runSweeperJobs() on demand. */

function notify(merchantId: string, title: string, body: string, category: string = 'system') {
  const note: NotificationDto = {
    id: uid('n'),
    merchantId,
    type: 'system',
    category: category as NotificationDto['category'],
    title,
    body,
    ts: Date.now(),
    read: false,
  };
  db.table<NotificationDto>('notifications').insert(note);
}

/* Fraud / risk engine — runs inside the sweeper. */
function runRiskChecks() {
  const merchants = db.table('merchants').where((m) => m.status === 'active');
  for (const merchant of merchants) {
    const m = merchant.id;
    const now = Date.now();
    const week = now - 7 * 86400000;
    const refunds = db.table<Refund>('refunds').where((r) => r.merchantId === m && r.createdAt >= week && r.status === 'approved');
    const completed = db.table<OrderDto>('orders').where((o) => o.merchantId === m && o.status === 'completed' && (o.completedAt ?? 0) >= week);
    const flag = (level: RiskEvent['level'], type: RiskEvent['type'], detail: string, dedupe?: (existing: RiskEvent) => boolean) => {
      const existing = db.table<RiskEvent>('riskEvents').where((r) => r.merchantId === m && r.type === type && r.status === 'open');
      if (existing.some((r) => (dedupe ? dedupe(r) : true))) return;
      db.table<RiskEvent>('riskEvents').insert({ id: uid('rk'), merchantId: m, level, type, detail, ts: now, status: 'open' });
      const note: NotificationDto = {
        id: uid('n'),
        merchantId: m,
        type: 'system',
        category: 'important',
        title: `Risk alert: ${type.replace('-', ' ')}`,
        body: detail,
        ts: now,
        read: false,
      };
      db.table<NotificationDto>('notifications').insert(note);
    };

    if (completed.length >= 5) {
      const ratio = refunds.length / completed.length;
      if (ratio > 0.15) {
        flag('high', 'refund-ratio', `Refund rate ${Math.round(ratio * 100)}% this week (${refunds.length}/${completed.length}) exceeds 15% threshold.`);
      }
    }
    const hourAgo = now - 3600000;
    const hourRefunds = refunds.filter((r) => r.createdAt >= hourAgo).length;
    if (hourRefunds >= 3) {
      flag('high', 'refund-velocity', `${hourRefunds} refunds approved in the last hour — possible abuse pattern.`);
    }
    const large = refunds.find((r) => r.amount > 200);
    if (large) {
      flag('medium', 'large-refund', `Large refund TZS ${large.amount.toFixed(2)} on ${large.orderId} — verify the customer story before payout.`);
    }
    const balance = db.table('ledger').where((e) => e.merchantId === m).sort((a, b) => b.ts - a.ts)[0]?.balance ?? 0;
    const withdraws = db.table('ledger').where((e) => e.merchantId === m && e.type === 'withdraw' && e.ts >= hourAgo);
    for (const w of withdraws) {
      if (Math.abs(w.amount) > balance * 0.8) {
        flag('medium', 'withdrawal-anomaly', `Withdrawal ${Math.abs(w.amount).toFixed(2)} is >80% of available balance.`);
      }
    }
    /* P8b: new-device login (login-risk) + order-velocity (unusual-order-pattern).
     * A session counts as a new device when the same staff has no other
     * session on that device in the prior 7 days (TASKS-RISK.md §104-108). */
    const sessions = db.table<{ id: string; staffId: string; merchantId: string; createdAt: number; device?: string }>('sessions');
    const staffIds = new Set(db.table('staff').where((s) => s.merchantId === m).map((s) => s.id));
    const recentLogins = sessions.where((s) => s.merchantId === m && s.createdAt >= hourAgo);
    for (const s of recentLogins) {
      if (!staffIds.has(s.staffId)) continue;
      const device = s.device ?? 'Merchant Pro App';
      const prior = sessions.where((o) => o.merchantId === m && o.staffId === s.staffId && o.id !== s.id && o.createdAt >= week && (o.device ?? 'Merchant Pro App') === device);
      if (!prior.length) {
        flag('high', 'login-risk', `New-device login for ${s.staffId} (${device}) — verify the staff member owns this device.`, (existing) => existing.detail.includes(device));
      }
    }
    const halfHour = now - 1800000;
    const burst = db.table<OrderDto>('orders').where((o) => o.merchantId === m && o.status === 'completed' && (o.completedAt ?? 0) >= halfHour);
    if (burst.length >= 8) {
      flag('high', 'unusual-order-pattern', `${burst.length} completed orders in the last 30 minutes — verify the order pattern (bulk/velocity anomaly).`);
    }
  }
}

/** Run all periodic mock-backend jobs once (rush, auto-cancel, campaigns, …). */
export function runSweeperJobs() {
  const ts = Date.now();
  const store = db.table('stores').find('s_demo');

  // 1. Rush: unaccepted orders older than 4.5 min get a rush + deadline bump.
  //    Cooldown: never re-rush an order rushed less than 10 min ago.
  //    Never rush an order that is already past its deadline — auto-cancel owns it.
  const stalled = db.table<OrderDto>('orders').where(
    (o) =>
      o.status === 'new' &&
      (!o.rushAt || o.rushAt < ts - 10 * 60000) &&
      o.createdAt < ts - 4.5 * 60000 &&
      (o.deadlineAt ?? 0) > ts &&
      !o.scheduledAt,
  );
  for (const o of stalled) {
    db.table<OrderDto>('orders').update(o.id, { rushAt: ts, rushReplied: false, deadlineAt: (o.deadlineAt ?? ts) + 2 * 60000, version: o.version + 1 });
    notify(o.merchantId, `Customer rushing · ${o.no}`, 'The customer asked you to prioritize this order.', 'order');
  }

  // 2. Auto-accept: store setting on — accept non-preorder orders after the delay.
  if (store?.orderSettings.autoAccept) {
    const due = db.table<OrderDto>('orders').where(
      (o) => o.status === 'new' && !o.scheduledAt && o.createdAt + store.orderSettings.autoAcceptDelaySec * 1000 <= ts,
    );
    for (const o of due) {
      try {
        const accepted = performAccept(o.id, 'system-auto', 'system');
        if (accepted) notify(o.merchantId, `Order auto-accepted · ${o.no}`, 'The order was accepted automatically per store settings.', 'order');
      } catch {
        /* OUT_OF_STOCK etc — leave for manual handling. */
      }
    }
  }

  // 3. Pre-order start reminder: within 15 min of the scheduled start.
  const soon = db.table<OrderDto>('orders').where(
    (o) =>
      (o.status === 'preparing' || o.status === 'new') &&
      !!o.scheduledAt &&
      o.scheduledAt - ts >= 0 &&
      o.scheduledAt - ts <= 15 * 60000 &&
      !(o as OrderDto & { reminderSent?: boolean }).reminderSent,
  );
  for (const o of soon) {
    const at = new Date(o.scheduledAt!);
    const hh = String(at.getHours()).padStart(2, '0');
    const mm = String(at.getMinutes()).padStart(2, '0');
    notify(o.merchantId, `Pre-order starting soon · ${o.no}`, `Scheduled for ${hh}:${mm} — make sure it is ready on time`, 'order');
    db.table<OrderDto>('orders').update(o.id, { reminderSent: true } as Partial<OrderDto> & { reminderSent: boolean });
  }

  // 4. Auto-cancel: new orders past deadline. Refund the customer for real
  //    when the payment was captured (refundPayment is idempotent via rf_<id>).
  const overdue = db.table<OrderDto>('orders').where((o) => o.status === 'new' && (o.deadlineAt ?? 0) < ts);
  for (const o of overdue) {
    db.table<OrderDto>('orders').update(o.id, {
      status: 'cancelled',
      version: o.version + 1,
      cancelledAt: ts,
      cancelReason: 'Not accepted in time — auto-cancelled',
      cancelReasonCode: 'AUTO_CANCEL',
      timeline: [...(o.timeline ?? []), { event: 'cancelled', ts: Date.now(), actor: 'system-auto-cancel' }],
    } as Partial<OrderDto> & { cancelReasonCode: string });
    refundPayment(o, 'Not accepted in time — auto-cancelled', 'AUTO_CANCEL', 'system-auto-cancel');
    notify(o.merchantId, `Order ${o.no} auto-cancelled`, 'The order was not accepted in time and was cancelled automatically.', 'important');
    // OF-04: a late accept attempt must surface ORDER_AUTO_CANCELLED — announce
    // the auto-cancel on the bus so clients render the 409-grade banner.
    emit({ type: 'orders.status_conflict', orderId: o.id, code: 'ORDER_AUTO_CANCELLED', at: ts });
  }

  // 5. Campaign ticks: impressions/clicks grow every sweep; spend bumps probabilistically.
  const active = db.table<CampaignDto>('campaigns').where((c) => c.status === 'active' && c.spent < c.budget);
  for (const c of active) {
    const impr = Math.round(200 + Math.random() * 700);
    db.table<CampaignDto>('campaigns').update(c.id, {
      impressions: (c.impressions ?? 0) + impr,
      clicks: (c.clicks ?? 0) + Math.round(impr * (0.03 + Math.random() * 0.02)),
    });
    if (Math.random() < 0.4) {
      const bump = Math.round(c.budget * (0.01 + Math.random() * 0.03) * 100) / 100;
      const next = Math.min(c.budget, Math.round((c.spent + bump) * 100) / 100);
      db.table<CampaignDto>('campaigns').update(c.id, { spent: next });
      if (next >= c.budget) db.table<CampaignDto>('campaigns').update(c.id, { status: 'expired' });
    }
  }

  // 5b. Promotion ticks (contract /promotions — PROMOTIONS.md): live promotions
  //     accrue impressions/clicks/spend; past budget -> ended with
  //     PROMOTION_BUDGET_EXCEEDED semantics; past endsAt -> ended.
  const promoTable = db.table<Promotion>('promotions');
  const livePromos = promoTable.where((p) => p.status === 'live');
  for (const p of livePromos) {
    if ((p.endsAt ?? 0) < ts) {
      const updated = promoTable.update(p.id, { status: 'ended' })!;
      emit({ type: 'promotion.updated', promotion: updated, at: ts });
      continue;
    }
    if (p.budgetTZS !== null && p.budgetTZS !== undefined && p.budgetTZS > 0) {
      const impr = Math.round(200 + Math.random() * 700);
      promoTable.update(p.id, {
        impressions: p.impressions + impr,
        clicks: p.clicks + Math.round(impr * (0.03 + Math.random() * 0.02)),
      });
      if (Math.random() < 0.4) {
        const bump = Math.max(1, Math.round(p.budgetTZS * (0.01 + Math.random() * 0.03)));
        const next = Math.min(p.budgetTZS, p.spendTZS + bump);
        promoTable.update(p.id, { spendTZS: next });
        if (next >= p.budgetTZS) {
          const exceeded = promoTable.update(p.id, { status: 'ended', budgetExceededReason: 'PROMOTION_BUDGET_EXCEEDED' })!;
          emit({ type: 'promotion.updated', promotion: exceeded, at: ts });
          notify(p.merchantId, 'Promotion budget reached', `"${p.title}" hit its budget and was ended server-side (PROMOTION_BUDGET_EXCEEDED).`, 'marketing');
        }
      }
    }
  }

  // 5c. DianJin ticks (contract /marketing/dianjin): active campaigns accrue
  //     clicks/spend; past budget -> delivery stopped with DIANJIN_BUDGET_EXCEEDED.
  const dianjinTable = db.table<DianjinCampaign>('dianjinCampaigns');
  const activeDianjin = dianjinTable.where((c) => c.active && (c.stoppedReason ?? null) === null && c.spendTZS < c.budgetTZS);
  for (const c of activeDianjin) {
    const clicks = Math.round(8 + Math.random() * 40);
    const spend = Math.max(1, Math.round(clicks * (c.bidBps / 100)));
    const nextSpend = Math.min(c.budgetTZS, c.spendTZS + spend);
    dianjinTable.update(c.id, { clicks: c.clicks + clicks, spendTZS: nextSpend });
    if (nextSpend >= c.budgetTZS) {
      const stopped = dianjinTable.update(c.id, { active: false, stoppedReason: 'DIANJIN_BUDGET_EXCEEDED' })!;
      emit({ type: 'marketing.dianjin_budget_exceeded', campaign: stopped, at: ts });
      notify(c.merchantId, 'DianJin budget reached', `"${c.name}" hit its budget — delivery stopped until you raise it.`, 'marketing');
    }
  }

  // 6. Promotion plan boost notice (occasionally).
  if (store?.promotion?.enabled && Math.random() < 0.15) {
    const boost = store.promotion.focus === 'ranking' ? 6.2 : 9.5;
    notify(
      store.merchantId,
      'Boost active',
      `Est. ${boost}k extra reach today from ${store.promotion.focus === 'ranking' ? 'search ranking' : 'feed impressions'}.`,
      'marketing',
    );
  }

  // 7. Onboarding: auto-approve pending merchants after 45s (demo review).
  const pending = db.table('merchants').where((m) => m.status === 'pending' && m.createdAt < ts - 45000);
  for (const m of pending) {
    db.table('merchants').update(m.id, { status: 'active', plan: 'pro' });
    notify(m.id, 'Onboarding approved 🎉', 'Your store is live. Customers can now find and order from you.', 'important');
  }

  // 8. Fraud / risk engine.
  runRiskChecks();

  const expiredProtections = db.table<ClosureProtection>('closureProtections').where((p) => p.status === 'active' && p.to < ts);
  for (const p of expiredProtections) {
    db.table<ClosureProtection>('closureProtections').update(p.id, { status: 'expired' });
    const store = db.table<StoreServer>('stores').find(p.storeId);
    if (store) {
      logStoreOp({ merchantId: store.merchantId, staffId: 'system', role: 'system' }, store.id, {
        action: 'closure:expire',
        field: 'status',
        before: 'active',
        after: 'expired',
      });
      notify(
        store.merchantId,
        'Closure protection ended',
        `The closure window (until ${new Date(p.to).toLocaleString()}) has ended — the store stays closed until you reopen it.`,
        'important',
      );
    }
  }

  // 9. Timed reopen: stores with a scheduledReopenAt that has arrived go back open.
  //    Closure protection blocks the reopen — the store stays closed under protection.
  const dueReopen = db.table<StoreServer>('stores').where((s) => !!s.scheduledReopenAt && s.scheduledReopenAt <= ts);
  for (const s of dueReopen) {
    const protectedStore = db
      .table<ClosureProtection>('closureProtections')
      .where((p) => p.storeId === s.id && p.status === 'active')[0];
    if (protectedStore) {
      db.table<StoreServer>('stores').update(s.id, { scheduledReopenAt: undefined });
      logStoreOp({ merchantId: s.merchantId, staffId: 'system', role: 'system' }, s.id, {
        action: 'store:reopen',
        field: 'open',
        before: false,
        after: false,
      });
      audit(s.merchantId, 'system', 'system', 'store:reopen', 'store', s.id, 'scheduled reopen cancelled — closure protection active');
      notify(s.merchantId, 'Scheduled reopen cancelled', 'Closure protection is active — the store stays closed under protection.', 'important');
      continue;
    }
    db.table<StoreServer>('stores').update(s.id, { open: true, scheduledReopenAt: undefined });
    logStoreOp({ merchantId: s.merchantId, staffId: 'system', role: 'system' }, s.id, {
      action: 'store:reopen',
      field: 'open',
      before: false,
      after: true,
    });
    audit(s.merchantId, 'system', 'system', 'store:reopen', 'store', s.id, 'scheduled reopen triggered');
    notify(s.merchantId, 'Store reopened automatically', 'Your scheduled reopen time has arrived — the store is open for orders.', 'important');
  }

  // 10. Reservation reminder (DINE-IN.md): confirmed reservations within 3h of
  //     the slot get a reservation.reminder push (once).
  const dueReminder = db
    .table<Reservation & { storeId: string }>('reservations')
    .where(
      (r) =>
        r.status === 'confirmed' &&
        r.scheduledFor - ts >= 0 &&
        r.scheduledFor - ts <= 3 * 3600000 &&
        !(r as Reservation & { reminderSent?: boolean }).reminderSent,
    );
  for (const r of dueReminder) {
    db.table<Reservation & { storeId: string }>('reservations').update(r.id, { reminderSent: true } as Partial<Reservation> & { reminderSent: boolean });
    notify(r.merchantId, 'Reservation coming up', `${r.partySize} guest(s) at ${new Date(r.scheduledFor).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} — table ready?`, 'important');
    emit({ type: 'reservation.reminder', reservation: r, at: ts });
  }

  // 11. Payout/withdrawal lifecycle (PAYMENTS.md): pending -> processing after
  //     60s, processing -> paid after 60s more; ~10% fail, ~10% hit an
  //     exception (deterministic per id, so tests can drive both paths).
  const withdrawals = db.table<Withdrawal & { merchantId: string }>('walletWithdrawals');
  const pendingW = withdrawals.where((w) => w.status === 'pending' && w.createdAt <= ts - 60000);
  for (const w of pendingW) {
    withdrawals.update(w.id, { status: 'processing', processingAt: ts } as Partial<Withdrawal> & { processingAt: number });
  }
  const processingW = withdrawals.where(
    (w) => w.status === 'processing' && (w as Withdrawal & { processingAt?: number }).processingAt !== undefined && (w as Withdrawal & { processingAt?: number }).processingAt! <= ts - 60000,
  );
  for (const w of processingW) {
    const n = w.id.split('').reduce((s, c) => s + c.charCodeAt(0), 0) % 10;
    const next = n === 0 ? 'failed' : n === 1 ? 'exception' : 'paid';
    withdrawals.update(w.id, {
      status: next,
      paidAt: next === 'paid' ? ts : null,
      reason: next === 'failed' ? 'Bank returned the transfer' : next === 'exception' ? 'Needs review — provider flagged the transfer' : null,
    } as Partial<Withdrawal> & { paidAt: number | null; reason: string | null });
    if (next === 'paid') {
      notify(w.merchantId, 'Withdrawal paid out', `TZS ${w.amountTZS.toLocaleString('en-US')} sent to your payout account.`, 'important');
    } else {
      notify(w.merchantId, next === 'failed' ? 'Withdrawal failed' : 'Withdrawal needs review', `TZS ${w.amountTZS.toLocaleString('en-US')} ${next === 'failed' ? 'was returned by the bank.' : 'is pending review — support will contact you.'}`, 'important');
    }
  }

  // 10b. Print-job lifecycle (ORDER-FLOW.md): queued → printing → done|failed.
  //     Receipt jobs that reach `done` append a row to the reprint history
  //     (GET /orders/receipts). A target device that is not online fails the
  //     job with PRINT_DEVICE_OFFLINE + `print.job_failed` in-app notification.
  const jobRows = db.table<PrintJob & { merchantId: string }>('printJobs').where((j) => j.status === 'queued' || j.status === 'printing');
  for (const job of jobRows) {
    const device = job.deviceId
      ? db.table<MerchantDevice>('devices').find(job.deviceId)
      : db.table<MerchantDevice>('devices').where((d) => d.purpose === 'receipt' && d.status === 'online')[0];
    const offline = device ? device.status !== 'online' : false;
    if (offline) {
      db.table<PrintJob & { merchantId: string }>('printJobs').update(job.id, { status: 'failed', error: 'PRINT_DEVICE_OFFLINE', completedAt: Date.now() });
      notify(job.merchantId, `Print job failed · ${job.label ?? job.jobType}`, 'The target printer is offline — connect it and retry the print.', 'important');
      emit({ type: 'print_jobs.failed', printJob: { ...job, status: 'failed', error: 'PRINT_DEVICE_OFFLINE' }, at: Date.now() });
      continue;
    }
    if (job.status === 'queued') {
      db.table<PrintJob & { merchantId: string }>('printJobs').update(job.id, { status: 'printing' });
      continue;
    }
    const doneAt = Date.now();
    db.table<PrintJob & { merchantId: string }>('printJobs').update(job.id, { status: 'done', completedAt: doneAt, error: null });
    if (job.jobType === 'receipt') {
      for (const orderId of job.orderIds ?? []) {
        const o = db.table<OrderDto>('orders').find(orderId);
        db.table('orderReceipts').insert({
          id: `rc_${job.id}_${orderId}`,
          merchantId: job.merchantId,
          orderId,
          printedAt: doneAt,
          jobId: job.id,
          no: o?.no,
        });
      }
    }
    emit({ type: 'print_jobs.updated', printJob: { ...job, status: 'done', completedAt: doneAt }, at: doneAt });
  }
}
