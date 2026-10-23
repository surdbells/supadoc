import type { Route } from '@angular/router';
import { unsavedChangesGuard } from '@supadoc/auth';
import { submittedGuard, trackSessionGuard, wizardStepGuard } from './core/guards';
import { STEPS } from './core/wizard-steps';

const T = (title: string) => `${title} · VideoMed`;
const stepTitle = (key: (typeof STEPS)[number]['key']) => {
  const s = STEPS.find((x) => x.key === key);
  return T(`${s?.title} · Step ${s?.n} of 7`);
};

export const appRoutes: Route[] = [
  {
    path: '',
    pathMatch: 'full',
    title: T('Join VideoMed as a Doctor'),
    loadComponent: () => import('./landing/landing').then((m) => m.OnbLanding),
  },
  {
    path: 'apply',
    pathMatch: 'full',
    title: T('Where are you licensed?'),
    loadComponent: () => import('./apply/licence-choice').then((m) => m.OnbLicenceChoice),
  },
  {
    path: 'apply/personal',
    title: stepTitle('personal'),
    canActivate: [wizardStepGuard('personal')],
    canDeactivate: [unsavedChangesGuard],
    loadComponent: () => import('./apply/personal-step').then((m) => m.OnbPersonalStep),
  },
  {
    path: 'apply/professional',
    title: stepTitle('professional'),
    canActivate: [wizardStepGuard('professional')],
    canDeactivate: [unsavedChangesGuard],
    loadComponent: () => import('./apply/professional-step').then((m) => m.OnbProfessionalStep),
  },
  {
    path: 'apply/licence',
    title: stepTitle('licence'),
    canActivate: [wizardStepGuard('licence')],
    canDeactivate: [unsavedChangesGuard],
    loadComponent: () => import('./apply/licence-step').then((m) => m.OnbLicenceStep),
  },
  {
    path: 'apply/qualifications',
    title: stepTitle('qualifications'),
    canActivate: [wizardStepGuard('qualifications')],
    canDeactivate: [unsavedChangesGuard],
    loadComponent: () => import('./apply/qualifications-step').then((m) => m.OnbQualificationsStep),
  },
  {
    path: 'apply/documents',
    title: stepTitle('documents'),
    canActivate: [wizardStepGuard('documents')],
    canDeactivate: [unsavedChangesGuard],
    loadComponent: () => import('./apply/documents-step').then((m) => m.OnbDocumentsStep),
  },
  {
    path: 'apply/indemnity',
    title: stepTitle('indemnity'),
    canActivate: [wizardStepGuard('indemnity')],
    canDeactivate: [unsavedChangesGuard],
    loadComponent: () => import('./apply/indemnity-step').then((m) => m.OnbIndemnityStep),
  },
  {
    path: 'apply/consent',
    title: stepTitle('consent'),
    canActivate: [wizardStepGuard('consent')],
    canDeactivate: [unsavedChangesGuard],
    loadComponent: () => import('./apply/consent-step').then((m) => m.OnbConsentStep),
  },
  {
    path: 'apply/review',
    title: T('Review your application'),
    canActivate: [wizardStepGuard('review')],
    canDeactivate: [unsavedChangesGuard],
    loadComponent: () => import('./apply/review').then((m) => m.OnbReview),
  },
  {
    path: 'apply/submitted',
    title: T('Application submitted'),
    canActivate: [submittedGuard],
    loadComponent: () => import('./apply/submitted').then((m) => m.OnbSubmitted),
  },
  {
    path: 'resume',
    title: T('Resuming your application'),
    loadComponent: () => import('./resume/resume-link').then((m) => m.OnbResumeLink),
  },
  {
    path: 'status',
    pathMatch: 'full',
    title: T('Application status'),
    canActivate: [trackSessionGuard],
    loadComponent: () => import('./status/status-page').then((m) => m.OnbStatusPage),
  },
  {
    path: 'status/respond',
    title: T('Send requested items'),
    canActivate: [trackSessionGuard],
    loadComponent: () => import('./status/respond-page').then((m) => m.OnbRespondPage),
  },
  { path: '**', redirectTo: '' },
];
