import { SUPADOC_ICONS } from './icons';

describe('SUPADOC_ICONS', () => {
  const names = SUPADOC_ICONS.map((icon) => icon.icon.name);

  it('registers the icons the doctor application site uses', () => {
    for (const name of [
      'calendar',
      'check-check',
      'circle-check-big',
      'circle',
      'chevrons-up-down',
      'file',
      'target',
    ]) {
      expect(names).toContain(name);
    }
  });

  it('registers the call-screen, viewer and availability icons', () => {
    for (const name of ['ellipsis', 'zoom-in', 'zoom-out', 'repeat', 'wifi', 'captions', 'captions-off']) {
      expect(names).toContain(name);
    }
  });

  it('registers the Laboratory & Diagnostics icons', () => {
    for (const name of ['microscope', 'flask-conical', 'stethoscope', 'circle-alert', 'circle-x', 'hourglass', 'file-text']) {
      expect(names).toContain(name);
    }
  });

  it('registers each icon once', () => {
    expect(new Set(names).size).toBe(names.length);
  });
});
