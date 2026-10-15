import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { SessionTimeoutDialog } from '@supadoc/auth';
import { DialogOutletComponent } from '@supadoc/ui';

@Component({
  imports: [RouterOutlet, DialogOutletComponent, SessionTimeoutDialog],
  selector: 'bo-root',
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {}
