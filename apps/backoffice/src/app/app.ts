import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

@Component({
  imports: [RouterOutlet],
  selector: 'bo-root',
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {}
