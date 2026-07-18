import { Component } from '@angular/core';
import {
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
} from '@ionic/angular/standalone';
import { LogoComponent } from '@supadoc/ui';

@Component({
  selector: 'mob-home',
  imports: [IonHeader, IonToolbar, IonTitle, IonContent, LogoComponent],
  template: `
    <ion-header>
      <ion-toolbar color="primary">
        <ion-title>VideoMed</ion-title>
      </ion-toolbar>
    </ion-header>
    <ion-content class="ion-padding">
      <div style="display: flex; flex-direction: column; gap: 16px;">
        <sd-logo [size]="44" />
        <h1
          style="margin: 0; font-family: 'Lexend Variable', sans-serif; font-weight: 700; font-size: 28px; line-height: 36px; color: #0a1628;"
        >
          Welcome
        </h1>
        <p style="margin: 0; color: #546e7a;">
          Patient mobile app — Ionic + Capacitor on the shared VideoMed design
          system.
        </p>
      </div>
    </ion-content>
  `,
})
export class HomePage {}
