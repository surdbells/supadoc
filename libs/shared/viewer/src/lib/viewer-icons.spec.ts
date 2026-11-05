import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  LUCIDE_ICONS,
  LucideChevronUp,
  LucideImage,
  LucideInfo,
  LucideKeyboard,
  LucideMaximize,
  LucideMinimize,
  LucideMoveHorizontal,
  LucidePanelLeft,
  LucidePanelLeftClose,
  LucidePictureInPicture2,
  LucideRotateCcw,
  LucideRotateCw,
  LucideScan,
} from '@lucide/angular';
import { IconComponent, provideSupadocIcons } from '@supadoc/ui';
import { iconDictionary, provideViewerIcons, VIEWER_ICONS } from './viewer-icons';

@Component({
  selector: 'sd-icon-probe',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [IconComponent],
  providers: [provideViewerIcons()],
  template: `<sd-icon name="x" /><sd-icon name="rotate-cw" /><sd-icon name="picture-in-picture-2" />`,
})
class ProbeComponent {}

describe('provideViewerIcons', () => {
  it('registers the viewer icons under their kebab-case names', () => {
    const names = Object.keys(iconDictionary(VIEWER_ICONS));
    for (const n of [
      'rotate-cw',
      'rotate-ccw',
      'panel-left',
      'panel-left-close',
      'maximize',
      'minimize',
      'keyboard',
      'image',
      'chevron-up',
      'picture-in-picture-2',
      'move-horizontal',
      'scan',
      'info',
    ]) {
      expect(names).toContain(n);
    }
  });

  it('matches the installed @lucide/angular icons (name, aliases and drawing)', () => {
    const installed = [LucideRotateCw, LucideRotateCcw, LucidePanelLeft, LucidePanelLeftClose, LucideMaximize, LucideMinimize, LucideKeyboard, LucideImage, LucideChevronUp, LucidePictureInPicture2, LucideMoveHorizontal, LucideScan, LucideInfo];
    expect(VIEWER_ICONS.length).toBe(installed.length);
    for (const cls of installed) {
      const mine = VIEWER_ICONS.find((i) => i.name === cls.icon.name);
      expect(mine, cls.icon.name).toBeDefined();
      expect(mine?.aliases ?? []).toEqual(cls.icon.aliases ?? []);
      const strip = (node: typeof cls.icon.node) => node.map(([tag, attrs]) => [tag, Object.fromEntries(Object.entries(attrs).filter(([k]) => k !== 'key'))]);
      expect(mine?.node).toEqual(strip(cls.icon.node));
    }
  });

  it('merges with the app set above it (the token is not multi): an app icon such as x still resolves', async () => {
    await TestBed.configureTestingModule({ imports: [ProbeComponent], providers: [provideSupadocIcons()] }).compileComponents();
    const f = TestBed.createComponent(ProbeComponent);
    expect(() => f.detectChanges()).not.toThrow();
    const icons = f.debugElement.injector.get(LUCIDE_ICONS);
    expect(icons['x']).toBeDefined();
    expect(icons['rotate-cw']).toBeDefined();
    expect(icons['picture-in-picture-2']).toBeDefined();
    expect((f.nativeElement as HTMLElement).querySelectorAll('svg').length).toBe(3);
  });
});
