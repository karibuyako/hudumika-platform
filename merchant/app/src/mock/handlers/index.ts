import type { HttpHandler } from 'msw';

import { authHandlers } from '@/mock/handlers/auth';
import { analyticsExtHandlers } from '@/mock/handlers/analytics-ext';
import { campaignHandlers } from '@/mock/handlers/campaigns';
import { catalogueHandlers } from '@/mock/handlers/catalogues';
import { catalogueExtHandlers } from '@/mock/handlers/catalogue-ext';
import { chainHandlers } from '@/mock/handlers/chain';
import { deviceHandlers } from '@/mock/handlers/devices';
import { financeHandlers } from '@/mock/handlers/finance';
import { merchantHandlers } from '@/mock/handlers/merchants';
import { messagingHandlers } from '@/mock/handlers/messaging';
import { opsHandlers } from '@/mock/handlers/ops';
import { productHandlers } from '@/mock/handlers/products';
import {
  analyticsHandlers,
  announcementHandlers,
  financeExtraHandlers,
  redemptionHandlers,
  reviewHandlers,
  riskHandlers,
  staffHandlers,
  supportExtraHandlers,
} from '@/mock/handlers/ops2';
import { biHandlers } from '@/mock/handlers/bi';
import { dineInHandlers } from '@/mock/handlers/dine-in';
import { groupBuyHandlers } from '@/mock/handlers/group-buy';
import { loyaltyHandlers } from '@/mock/handlers/loyalty';
import { marketingHandlers } from '@/mock/handlers/marketing';
import { notificationSettingsHandlers } from '@/mock/handlers/notifications-settings';
import { orderHandlers } from '@/mock/handlers/orders';
import { printJobsHandlers } from '@/mock/handlers/print-jobs';
import { promotionHandlers } from '@/mock/handlers/promotions';
import { refundHandlers } from '@/mock/handlers/refunds';
import { reportHandlers } from '@/mock/handlers/reports';
import { staffOpsHandlers } from '@/mock/handlers/staff-ops';
import { storeOpsHandlers } from '@/mock/handlers/store-ops';
import { supplyChainHandlers } from '@/mock/handlers/supply-chain';
import { taskHandlers } from '@/mock/handlers/tasks';
import { webhookHandlers } from '@/mock/handlers/webhooks';

/** Mock module names — each maps to one EXPO_PUBLIC_MOCK_* switch (see src/mock/switches.ts). */
export type MockModuleName =
  | 'auth'
  | 'orders'
  | 'catalog'
  | 'catalogues'
  | 'merchants'
  | 'finance'
  | 'bi'
  | 'marketing'
  | 'promotions'
  | 'groupBuy'
  | 'messaging'
  | 'notifications'
  | 'ops'
  | 'store'
  | 'loyalty'
  | 'devices'
  | 'catalogueExt'
  | 'chain'
  | 'supplyChain'
  | 'webhooks'
  | 'tasks'
  | 'staffOps'
  | 'reports'
  | 'analyticsExt'
  | 'printJobs';

/** Handler groups by module, used to filter mocks when some switches are off. */
export const HANDLERS_BY_MODULE: Record<MockModuleName, readonly HttpHandler[]> = {
  auth: authHandlers,
  orders: [...orderHandlers, ...refundHandlers],
  catalog: productHandlers,
  catalogues: catalogueHandlers,
  merchants: merchantHandlers,
  finance: [...financeHandlers, ...financeExtraHandlers],
  bi: [...biHandlers, ...analyticsHandlers],
  marketing: [...campaignHandlers, ...redemptionHandlers, ...marketingHandlers],
  promotions: promotionHandlers,
  groupBuy: groupBuyHandlers,
  messaging: messagingHandlers,
  notifications: notificationSettingsHandlers,
  ops: [...opsHandlers, ...staffHandlers, ...riskHandlers, ...reviewHandlers, ...announcementHandlers, ...supportExtraHandlers],
  store: [...storeOpsHandlers, ...dineInHandlers],
  loyalty: loyaltyHandlers,
  devices: deviceHandlers,
  catalogueExt: catalogueExtHandlers,
  chain: chainHandlers,
  supplyChain: supplyChainHandlers,
  webhooks: webhookHandlers,
  tasks: taskHandlers,
  staffOps: staffOpsHandlers,
  reports: reportHandlers,
  analyticsExt: analyticsExtHandlers,
  printJobs: printJobsHandlers,
};

/** All HTTP handlers (Node-safe — no react-native, no service worker). */
export const ALL_HTTP_HANDLERS: readonly HttpHandler[] = [
  ...authHandlers,
  ...biHandlers,
  ...orderHandlers,
  ...refundHandlers,
  ...financeHandlers,
  ...catalogueHandlers,
  ...merchantHandlers,
  ...messagingHandlers,
  ...notificationSettingsHandlers,
  ...campaignHandlers,
  ...opsHandlers,
  ...productHandlers,
  ...redemptionHandlers,
  ...reviewHandlers,
  ...staffHandlers,
  ...financeExtraHandlers,
  ...riskHandlers,
  ...analyticsHandlers,
  ...announcementHandlers,
  ...supportExtraHandlers,
  ...storeOpsHandlers,
  ...groupBuyHandlers,
  ...loyaltyHandlers,
  ...dineInHandlers,
  ...deviceHandlers,
  ...promotionHandlers,
  ...marketingHandlers,
  ...catalogueExtHandlers,
  ...chainHandlers,
  ...supplyChainHandlers,
  ...webhookHandlers,
  ...taskHandlers,
  ...staffOpsHandlers,
  ...reportHandlers,
  ...analyticsExtHandlers,
  ...printJobsHandlers,
];
