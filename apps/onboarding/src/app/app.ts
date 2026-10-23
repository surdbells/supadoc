import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { DialogOutletComponent } from '@supadoc/ui';

@Component({
  imports: [RouterOutlet, DialogOutletComponent],
  selector: 'onb-root',
  templateUrl: './app.html',
})
export class App {}
