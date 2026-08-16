/* Native RTL wiring: react-native's I18nManager cannot be imported from
 * @/i18n (the dict module is bundled into node test runs), so the flip lives
 * here and is applied from the locale switcher screen (profile/settings).
 * Web RTL is handled inside @/i18n via the html `dir` attribute. */
import { I18nManager } from 'react-native';

import type { Locale } from '@/i18n';

export function syncRTL(locale: Locale) {
  I18nManager.allowRTL(true);
  I18nManager.forceRTL(locale === 'ar');
}
