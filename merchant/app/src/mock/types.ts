import type {
  CampaignDto,
  ChatThreadDto,
  Invoice,
  NotificationDto,
  OrderDto,
  Payment,
  Refund,
  Settlement,
} from '@/api/types';

export type Notification = NotificationDto;
export type ChatThread = ChatThreadDto;
export type Order = OrderDto;
export type Campaign = CampaignDto;
export type { Invoice, Payment, Refund, Settlement };
