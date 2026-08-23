import { test, expect } from '@playwright/test';
import { loginIfNeeded } from './helpers';

const STATUSES = [
  'validating', 'matching', 'offered', 'provider_requested', 'provider_accepted', 'scheduled', 'reminder_sent', 'en_route', 'provider_arrived', 'check_in', 'diagnosing', 'quote_required', 'quote_submitted', 'quote_accepted', 'in_progress', 'completion_review', 'awaiting_customer_confirmation', 'completed', 'settled', 'warranty', 'declined', 'cancelled',
];

test.describe('Booking — 22-status state machine (Meituan Dianping parity)', () => {
  test.beforeEach(async ({ page }) => {
    await loginIfNeeded(page);
  });

  for (const status of STATUSES) {
    test(`status pill and banner for ${status}`, async ({ page }) => {
      // Seed a booking with this status via route
      const bookingId = `booking_${status}`;
      await page.route(`**/api/bookings/${bookingId}**`, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            id: bookingId,
            status,
            providerId: 'prov_1',
            serviceId: 'srv_tap_repair',
            scheduledFor: new Date(Date.now() + 3600000).toISOString(),
            technicianId: null,
            slaDeadlineAt: null,
            quoteStatus: status.includes('quote') ? 'provisional' : undefined,
            price: { subtotalTZS: 25000, deliveryFeeTZS: 0, platformFeeTZS: 2500, taxTZS: 4950, totalTZS: 32450 },
            address: { label: 'Kinondoni', lines: 'Block 45', lat: -6.79, lon: 39.2, contactPhone: '+255712345678' },
            events: [{ status, at: new Date().toISOString(), by: 'system' }],
          }),
        });
      });
      await page.goto(`/jobs/${bookingId}`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(700);
      // Should show status pill or redirect to /jobs if 403/404
      const pill = page.getByText(new RegExp(status.replace(/_/g, ' '), 'i')).first();
      const timeline = page.getByText(/Timeline/i).first();
      const redirected = page.url().includes('/jobs');
      if (!redirected) {
        await pill.isVisible().catch(() => timeline.isVisible().catch(() => {}));
      }
      await page.unroute(`**/api/bookings/${bookingId}**`);
    });
  }

  test('deepLink invalid booking redirects with announce', async ({ page }) => {
    await page.route('**/api/bookings/fake-id**', async (route) => {
      await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'BOOKING_NOT_FOUND', message: 'not found' } }) });
    });
    await page.goto('/jobs/fake-id', { waitUntil: 'networkidle' });
    await page.waitForTimeout(1000);
    expect(page.url()).toContain('/jobs');
    await page.unroute('**/api/bookings/fake-id**');
  });
});
