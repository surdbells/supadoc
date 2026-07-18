import { Component } from '@angular/core';
import {
  IonHeader,
  IonToolbar,
  IonTitle,
  IonContent,
} from '@ionic/angular/standalone';
import { IconComponent } from '@supadoc/ui';

@Component({
  selector: 'mob-home',
  imports: [IonHeader, IonToolbar, IonTitle, IonContent, IconComponent],
  template: `
    <ion-header>
      <ion-toolbar color="primary">
        <ion-title>Supadoc</ion-title>
      </ion-toolbar>
    </ion-header>
    <ion-content class="ion-padding">
      <div style="display: flex; align-items: center; gap: 8px;">
        <sd-icon name="heart-pulse" [size]="24" />
        <h1 style="margin: 0;">Welcome</h1>
      </div>
      <p>Patient mobile app — Ionic + Capacitor scaffold with Lucide icons.</p>
    </ion-content>
  `,
})
export class HomePage {}
