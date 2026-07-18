import { TestBed } from '@angular/core/testing';
import { ButtonComponent } from './button';

describe('ButtonComponent', () => {
  it('renders a button with the variant + size classes applied', async () => {
    await TestBed.configureTestingModule({
      imports: [ButtonComponent],
    }).compileComponents();

    const fixture = TestBed.createComponent(ButtonComponent);
    fixture.componentRef.setInput('variant', 'primary');
    fixture.componentRef.setInput('size', 'lg');
    fixture.detectChanges();

    const button: HTMLButtonElement =
      fixture.nativeElement.querySelector('button');
    expect(button).toBeTruthy();
    expect(button.className).toContain('bg-brand-500');
    expect(button.className).toContain('h-12');
  });
});
