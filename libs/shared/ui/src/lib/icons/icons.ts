import { Provider } from '@angular/core';
import {
  provideLucideIcons,
  LucideArrowRight,
  LucideBanknote,
  LucideBell,
  LucideCalendarClock,
  LucideCalendarDays,
  LucideCheck,
  LucideChevronDown,
  LucideCirclePlay,
  LucideClipboardList,
  LucideClock,
  LucideEye,
  LucideEyeOff,
  LucideFileText,
  LucideHeartPulse,
  LucideHistory,
  LucideHouse,
  LucideLayoutDashboard,
  LucideLock,
  LucideLogOut,
  LucideMail,
  LucideMapPin,
  LucideMenu,
  LucideMessageSquare,
  LucidePhone,
  LucidePill,
  LucidePlus,
  LucideSearch,
  LucideSettings,
  LucideShield,
  LucideShieldCheck,
  LucideStethoscope,
  LucideUser,
  LucideUserRound,
  LucideUsers,
  LucideVideo,
  LucideWallet,
  LucideX,
} from '@lucide/angular';

/**
 * The Lucide icons registered app-wide and usable as `<sd-icon name="...">`.
 * Names are the kebab-case Lucide names, e.g. `LucideCalendarDays` => "calendar-days".
 *
 * Add the icons your features need here — keeping the set curated keeps bundles
 * small. Browse the full set at https://lucide.dev/icons.
 */
export const SUPADOC_ICONS = [
  LucideHouse,
  LucideLayoutDashboard,
  LucideUser,
  LucideUserRound,
  LucideUsers,
  LucideStethoscope,
  LucideHeartPulse,
  LucidePill,
  LucideCalendarDays,
  LucideCalendarClock,
  LucideChevronDown,
  LucideCirclePlay,
  LucideClipboardList,
  LucideClock,
  LucideFileText,
  LucideHistory,
  LucideMapPin,
  LucideMessageSquare,
  LucideVideo,
  LucideBell,
  LucideBanknote,
  LucideWallet,
  LucideSearch,
  LucideSettings,
  LucideMenu,
  LucidePlus,
  LucideArrowRight,
  LucideCheck,
  LucideX,
  LucideLogOut,
  LucideMail,
  LucideLock,
  LucidePhone,
  LucideEye,
  LucideEyeOff,
  LucideShield,
  LucideShieldCheck,
];

/**
 * Registers the Supadoc Lucide icon set. Add to an app's `app.config.ts`
 * providers so `<sd-icon name="...">` can resolve icons by name.
 */
export function provideSupadocIcons(): Provider {
  return provideLucideIcons(...SUPADOC_ICONS);
}
