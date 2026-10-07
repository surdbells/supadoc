import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { SessionTimeoutDialog } from '@supadoc/auth';

@Component({
  imports: [RouterOutlet, SessionTimeoutDialog],
  selector: 'pat-root',
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {}
