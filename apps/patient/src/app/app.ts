import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { SessionTimeoutDialog } from '@supadoc/auth';
import { DialogOutletComponent } from '@supadoc/ui';

@Component({
  // <sd-dialog-outlet /> renders every DialogService prompt (confirmations,
  // "Leave without saving?"). The idle-timeout warning opens over any of them.
  imports: [RouterOutlet, DialogOutletComponent, SessionTimeoutDialog],
  selector: 'pat-root',
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {}
