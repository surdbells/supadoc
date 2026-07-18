import { Provider } from '@angular/core';
import {
  provideLucideIcons,
  LucideArrowRight,
  LucideBell,
  LucideCalendarClock,
  LucideCalendarDays,
  LucideCheck,
  LucideClipboardList,
  LucideFileText,
  LucideHeartPulse,
  LucideHouse,
  LucideLayoutDashboard,
  LucideLogOut,
  LucideMenu,
  LucideMessageSquare,
  LucidePill,
  LucidePlus,
  LucideSearch,
  LucideSettings,
  LucideStethoscope,
  LucideUser,
  LucideUsers,
  LucideVideo,
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
  LucideUsers,
  LucideStethoscope,
  LucideHeartPulse,
  LucidePill,
  LucideCalendarDays,
  LucideCalendarClock,
  LucideClipboardList,
  LucideFileText,
  LucideMessageSquare,
  LucideVideo,
  LucideBell,
  LucideSearch,
  LucideSettings,
  LucideMenu,
  LucidePlus,
  LucideArrowRight,
  LucideCheck,
  LucideX,
  LucideLogOut,
];

/**
 * Registers the Supadoc Lucide icon set. Add to an app's `app.config.ts`
 * providers so `<sd-icon name="...">` can resolve icons by name.
 */
export function provideSupadocIcons(): Provider {
  return provideLucideIcons(...SUPADOC_ICONS);
}
