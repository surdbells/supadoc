import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  OnInit,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { type Observable } from 'rxjs';
import {
  apiErrorMessage,
  DoctorApi,
  openBlobDocument,
  openClinicalDocument,
} from '@supadoc/data-access';
import type {
  AppointmentDto,
  CarePlanDto,
  ClinicalDocumentKind,
  ClinicalNoteDto,
  ConsentDto,
  CopilotDraftDto,
  DoctorAppointmentDto,
  DoctorPatientRecordDto,
  DoctorRecordingStateDto,
  LabOrderDto,
  MedicalCertificateDto,
  MedicalDocumentDto,
  MessageDto,
  RecordingFileDto,
  ReferralDto,
  SuccessResponse,
  TranscriptSegmentDto,
} from '@supadoc/models';
import { AlertComponent, IconComponent, MessageThreadComponent } from '@supadoc/ui';
import { MedicationItem, VisitStatusBadge } from '../patients/patient-record-ui';
import { RxPanel } from '../prescriptions/rx-panel';
import { ClinicalAi } from './clinical/clinical-ai';
import { ClinicalCarePlan } from './clinical/clinical-care-plan';
import { ClinicalCertificates } from './clinical/clinical-certificates';
import { ClinicalConsents } from './clinical/clinical-consents';
import { ClinicalLabs } from './clinical/clinical-labs';
import { ClinicalNote, type NoteSaveMode } from './clinical/clinical-note';
import { ClinicalRecording } from './clinical/clinical-recording';
import { ClinicalReferrals } from './clinical/clinical-referrals';
import { ClinicalHeader } from './clinical/clinical-ui';

type PrimaryTab = 'overview' | 'history' | 'documents' | 'visits' | 'clinical';

type TabKey =
  | 'notes'
  | 'messages'
  | 'prescriptions'
  | 'labs'
  | 'care'
  | 'referrals'
  | 'certificates'
  | 'consents'
  | 'recording'
  | 'ai';

interface Tab {
  readonly key: TabKey;
  readonly label: string;
  readonly icon: string;
}

const TABS: Tab[] = [
  { key: 'notes', label: 'Clinical note', icon: 'file-text' },
  { key: 'messages', label: 'Messages', icon: 'message-square' },
  { key: 'prescriptions', label: 'Prescriptions', icon: 'pill' },
  { key: 'labs', label: 'Lab orders', icon: 'clipboard-list' },
  { key: 'care', label: 'Care plan', icon: 'list-checks' },
  { key: 'referrals', label: 'Referrals', icon: 'share-2' },
  { key: 'certificates', label: 'Certificates', icon: 'id-card' },
  { key: 'consents', label: 'Consents', icon: 'shield-check' },
  { key: 'recording', label: 'Recording', icon: 'circle-play' },
  { key: 'ai', label: 'Transcript & AI', icon: 'sparkles' },
];

/** A Clinical tools sub-tab button: the primary tabs' pill, stacked into a rail on desktop. */
const SUB_TAB =
  'flex shrink-0 items-center gap-2 whitespace-nowrap rounded-pill px-4 py-2 font-sans text-body-sm font-semibold transition-colors ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40 lg:rounded-field lg:py-2.5';

/**
 * A consultation's Schedule Details (route `/appointments/:id`) — the design's
 * pre-consultation patient briefing (Overview / Medical History / Documents /
 * Past Visits) plus a "Clinical tools" tab that preserves all out-of-call
 * authoring (notes, prescriptions, labs, referrals, certificates, recording, AI).
 * Each Clinical tools sub-tab is a presentational child in `./clinical/`; this
 * component keeps all of their state, loading and API calls.
 */
@Component({
  selector: 'doc-appointment-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgTemplateOutlet,
    RouterLink,
    AlertComponent,
    IconComponent,
    MessageThreadComponent,
    RxPanel,
    ClinicalAi,
    ClinicalCarePlan,
    ClinicalCertificates,
    ClinicalConsents,
    ClinicalHeader,
    ClinicalLabs,
    ClinicalNote,
    ClinicalRecording,
    ClinicalReferrals,
    MedicationItem,
    VisitStatusBadge,
  ],
  host: { class: 'block' },
  template: `
    <div class="flex flex-col gap-6 py-2">
      <div class="flex items-center justify-between">
        <h1 class="font-heading text-h3 text-ink">Schedule Details</h1>
        <a routerLink="/schedule" class="flex items-center gap-1 font-sans text-body text-slate transition-colors hover:text-cerulean">
          <sd-icon name="chevron-right" [size]="18" class="rotate-180" /> Back
        </a>
      </div>

      @if (apptError()) {
        <div class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white py-16 text-center">
          <sd-icon name="calendar-off" [size]="32" class="text-alert" />
          <p class="font-sans text-body-sm text-slate">{{ apptError() }}</p>
        </div>
      } @else if (appt(); as a) {
        <!-- Summary + Quick actions -->
        <section class="grid gap-6 rounded-card border border-cloud bg-white p-6 lg:grid-cols-[1fr_auto]">
          <div class="flex flex-col gap-4">
            <div class="flex items-start gap-4">
              <span class="flex size-14 shrink-0 items-center justify-center rounded-full bg-frost font-heading text-body-lg font-semibold text-cerulean">{{ initialsFor(a.patient_name) }}</span>
              <div class="flex flex-col gap-1">
                <div class="flex flex-wrap items-center gap-2.5">
                  <span class="font-heading text-h4 text-cerulean">{{ a.patient_name }}</span>
                  <doc-visit-status-badge [status]="a.status" [label]="a.status_label" />
                </div>
                @if (age() !== null) { <span class="font-sans text-body-sm text-slate">{{ age() }} years</span> }
              </div>
            </div>

            <div class="grid grid-cols-1 gap-x-8 gap-y-2 sm:grid-cols-2">
              <span class="flex items-center gap-2 font-sans text-body-sm text-ink"><sd-icon name="calendar-days" [size]="16" class="text-slate" />{{ dateLabel(a.scheduled_at) }}</span>
              <span class="flex items-center gap-2 font-sans text-body-sm text-ink"><sd-icon name="video" [size]="16" class="text-slate" />{{ a.type_label }}</span>
              <span class="flex items-center gap-2 font-sans text-body-sm text-ink"><sd-icon name="clock" [size]="16" class="text-slate" />{{ time(a.scheduled_at) }}</span>
              @if (patientRecord()?.patient?.phone) {
                <span class="flex items-center gap-2 font-sans text-body-sm text-ink"><sd-icon name="phone" [size]="16" class="text-slate" />{{ patientRecord()?.patient?.phone }}</span>
              }
            </div>

            <div class="flex flex-wrap items-center gap-3">
              <span class="font-sans text-body-sm text-slate">Fee: <span class="font-semibold text-ink">{{ money(a.amount) }}</span></span>
              @if (a.payment_status === 'paid') {
                <span class="inline-flex items-center gap-1 rounded-pill bg-sage/15 px-2.5 py-0.5 font-sans text-caption font-semibold text-sage"><sd-icon name="circle-check" [size]="13" />Paid</span>
              } @else {
                <span class="inline-flex items-center gap-1 rounded-pill bg-warning/15 px-2.5 py-0.5 font-sans text-caption font-semibold text-ink"><sd-icon name="circle-alert" [size]="13" />Unpaid</span>
              }
            </div>

            @if (a.notes) {
              <div class="flex flex-col gap-1 border-t border-cloud pt-3">
                <span class="font-sans text-caption text-slate">Reason for Consultation:</span>
                <span class="font-sans text-body-sm text-ink">{{ a.notes }}</span>
              </div>
            }
          </div>

          <div class="flex w-full flex-col gap-3 lg:w-64">
            <span class="font-heading text-body-lg text-ink">Quick actions</span>
            @if (a.status === 'pending' || a.status === 'rescheduled') {
              <button type="button" class="flex items-center justify-center gap-2 rounded-field bg-cerulean px-5 py-3 font-sans text-body-sm font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60" [disabled]="actionBusy()" (click)="confirm()">
                <sd-icon name="circle-check" [size]="18" />{{ actionBusy() ? 'Working…' : 'Confirm appointment' }}
              </button>
            } @else {
              <button type="button" class="flex items-center justify-center gap-2 rounded-field px-5 py-3 font-sans text-body-sm font-semibold transition-colors"
                [class]="joinState().enabled ? 'bg-cerulean text-white hover:bg-ocean' : 'bg-cerulean/40 text-white cursor-not-allowed'"
                [disabled]="!joinState().enabled" (click)="join(a)">
                <sd-icon name="video" [size]="18" />{{ joinState().label }}
              </button>
            }
            <div class="flex gap-3">
              @if (canReschedule(a.status)) {
                <button type="button" class="flex flex-1 items-center justify-center gap-2 rounded-field border border-cloud px-4 py-2.5 font-sans text-body-sm font-semibold text-slate transition-colors hover:border-cerulean hover:text-cerulean" (click)="toggleReschedule()">
                  <sd-icon name="refresh-cw" [size]="16" />Reschedule
                </button>
              }
              @if (canCancel(a.status)) {
                <button type="button" class="flex flex-1 items-center justify-center gap-2 rounded-field border border-alert/50 px-4 py-2.5 font-sans text-body-sm font-semibold text-alert transition-colors hover:bg-alert/5 disabled:opacity-60" [disabled]="actionBusy()" (click)="decline()">
                  <sd-icon name="ban" [size]="16" />Cancel
                </button>
              }
            </div>
            @if (rescheduleOpen()) {
              <div class="flex flex-col gap-2 rounded-field border border-cloud p-3">
                <input type="datetime-local" class="rounded-field border border-cloud bg-white px-3 py-2 font-sans text-body-sm text-ink focus:border-cerulean focus:outline-none" [value]="rescheduleAt()" (input)="rescheduleAt.set($any($event.target).value)" />
                <button type="button" class="rounded-field bg-cerulean px-4 py-2 font-sans text-caption font-semibold text-white transition-colors hover:bg-ocean disabled:opacity-60" [disabled]="actionBusy()" (click)="submitReschedule()">{{ actionBusy() ? 'Saving…' : 'Save new time' }}</button>
              </div>
            }
            @if (actionError()) { <p class="rounded-field bg-alert/10 px-3 py-2 font-label text-caption text-alert">{{ actionError() }}</p> }
          </div>
        </section>

        <!-- Primary tabs -->
        <div class="flex w-fit max-w-full gap-1 overflow-x-auto rounded-pill border border-cloud bg-white p-1">
          @for (t of primaryTabs; track t.key) {
            <button type="button" class="whitespace-nowrap rounded-pill px-5 py-2 font-sans text-body-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cerulean/40"
              [class]="primary() === t.key ? 'bg-frost text-cerulean' : 'text-slate hover:text-ink'"
              (click)="primary.set(t.key)">{{ t.label }}</button>
          }
        </div>

        @switch (primary()) {
          <!-- ===== Overview ===== -->
          @case ('overview') {
            @if (loadingRecord()) {
              <div class="sd-shimmer h-40 rounded-card"></div>
            } @else if (recordError()) {
              <ng-container [ngTemplateOutlet]="recordFailed" />
            } @else if (medications().length === 0) {
              <ng-container [ngTemplateOutlet]="unavailable" />
            } @else {
              <div class="flex flex-col gap-6">
                <section class="flex flex-col gap-3">
                  <h2 class="flex items-center gap-2 font-heading text-body-lg text-ink"><sd-icon name="pill" [size]="20" class="text-cerulean" />Current Medication</h2>
                  @if (medications().length) {
                    <!-- Same medication row as the patient record (dose · frequency, reason, Herbal chip). -->
                    <ul class="flex flex-col divide-y divide-cloud rounded-card border border-cloud bg-white">
                      @for (m of medications(); track $index) {
                        <li class="px-4 py-3"><doc-medication-item [med]="m" /></li>
                      }
                    </ul>
                  } @else {
                    <p class="rounded-card bg-glacier px-4 py-3 font-sans text-body-sm text-slate">No medications recorded.</p>
                  }
                </section>
              </div>
            }
          }

          <!-- ===== Medical History ===== -->
          @case ('history') {
            @if (loadingRecord()) {
              <div class="sd-shimmer h-40 rounded-card"></div>
            } @else if (recordError()) {
              <ng-container [ngTemplateOutlet]="recordFailed" />
            } @else if (conditions().length === 0 && allergies().length === 0 && pastHistory().length === 0) {
              <ng-container [ngTemplateOutlet]="unavailable" />
            } @else {
              <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
                <section class="flex flex-col gap-3 rounded-card border border-cloud bg-white p-6">
                  <h3 class="flex items-center gap-2 font-heading text-body-lg text-ink"><sd-icon name="pill" [size]="18" class="text-cerulean" />Chronic Conditions</h3>
                  @if (conditions().length) {
                    <div class="flex flex-wrap gap-2">
                      @for (c of conditions(); track $index) { <span class="rounded-pill bg-frost px-3 py-1 font-sans text-caption font-medium text-cerulean">{{ c.condition }}</span> }
                    </div>
                  } @else { <p class="font-sans text-body-sm text-slate">None recorded.</p> }
                </section>
                <section class="flex flex-col gap-3 rounded-card border border-cloud bg-white p-6">
                  <h3 class="flex items-center gap-2 font-heading text-body-lg text-ink"><sd-icon name="triangle-alert" [size]="18" class="text-alert" />Allergies</h3>
                  @if (allergies().length) {
                    <div class="flex flex-wrap gap-2">
                      @for (al of allergies(); track $index) { <span class="rounded-pill bg-alert/10 px-3 py-1 font-sans text-caption font-medium text-alert">{{ al.allergen }}</span> }
                    </div>
                  } @else { <p class="font-sans text-body-sm text-slate">None recorded.</p> }
                </section>
                <section class="flex flex-col gap-3 rounded-card border border-cloud bg-white p-6">
                  <h3 class="flex items-center gap-2 font-heading text-body-lg text-ink"><sd-icon name="clipboard-list" [size]="18" class="text-cerulean" />Past Medical History</h3>
                  @if (pastHistory().length) {
                    <ul class="flex flex-col gap-2">
                      @for (h of pastHistory(); track $index) {
                        <li class="flex items-start gap-2 font-sans text-body-sm text-ink"><sd-icon name="check" [size]="16" class="mt-0.5 shrink-0 text-cerulean" /><span>{{ h.year ? h.year + ' - ' : '' }}{{ h.condition }}{{ h.note ? ' (' + h.note + ')' : '' }}</span></li>
                      }
                    </ul>
                  } @else { <p class="font-sans text-body-sm text-slate">None recorded.</p> }
                </section>
              </div>
            }
          }

          <!-- ===== Documents ===== -->
          @case ('documents') {
            <div class="flex flex-col gap-4">
              @if (patientDocs().length > 0) {
                <div class="flex flex-wrap items-center gap-3">
                  <div class="relative min-w-[220px] flex-1">
                    <sd-icon name="search" [size]="16" class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate" />
                    <input class="w-full rounded-field border border-cloud bg-white py-2.5 pl-9 pr-3 font-sans text-body-sm text-ink placeholder:text-slate/50 focus:border-cerulean focus:outline-none" placeholder="Search Document" [value]="docSearch()" (input)="docSearch.set($any($event.target).value)" />
                  </div>
                </div>
              }
              @if (loadingDocs()) {
                <div class="sd-shimmer h-24 rounded-card"></div>
              } @else if (docsError()) {
                <div class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white py-16 text-center">
                  <sd-icon name="wifi-off" [size]="32" class="text-alert" />
                  <p class="font-sans text-body-sm text-slate">{{ docsError() }}</p>
                </div>
              } @else if (filteredDocs().length === 0) {
                <div class="flex flex-col items-center gap-3 py-16 text-center">
                  <span class="flex size-20 items-center justify-center rounded-full bg-cloud/60 text-slate"><sd-icon name="file-text" [size]="34" /></span>
                  <p class="font-sans text-body-sm text-slate">{{ docSearch() ? 'No documents match your search.' : 'No document yet' }}</p>
                </div>
              } @else {
                <ul class="flex flex-col gap-3">
                  @for (d of filteredDocs(); track d.id) {
                    <li>
                      <button type="button" class="flex w-full items-center gap-4 rounded-card border border-cloud bg-white p-4 text-left transition-colors hover:border-cerulean/40" (click)="openPatientDoc(d)">
                        <span class="flex size-11 shrink-0 items-center justify-center rounded-full bg-cloud/60 text-slate"><sd-icon name="file-text" [size]="20" /></span>
                        <div class="flex min-w-0 flex-1 flex-col">
                          <span class="truncate font-sans text-body-sm font-semibold text-ink">{{ d.title }}</span>
                          <span class="font-sans text-caption text-slate">{{ d.extension || d.mime_type }} · {{ d.size_label }}</span>
                        </div>
                        <span class="hidden font-sans text-body-sm text-slate sm:block">{{ d.type_label }}</span>
                        <span class="hidden font-sans text-caption text-slate md:block">{{ shortDate(d.created_at) }}</span>
                        <span class="rounded-pill px-2.5 py-0.5 font-sans text-caption font-semibold" [class]="d.uploader_role === 'patient' ? 'bg-sage/15 text-sage' : 'bg-warning/15 text-warning'">{{ d.uploader_role === 'patient' ? 'Patient-upload' : 'Doctor-uploaded' }}</span>
                        <sd-icon name="chevron-right" [size]="20" class="shrink-0 text-slate" />
                      </button>
                    </li>
                  }
                </ul>
              }
            </div>
          }

          <!-- ===== Past Visits ===== -->
          @case ('visits') {
            @if (loadingRecord()) {
              <div class="sd-shimmer h-32 rounded-card"></div>
            } @else if (recordError()) {
              <ng-container [ngTemplateOutlet]="recordFailed" />
            } @else if (pastVisits().length === 0) {
              <div class="flex flex-col items-center gap-3 py-16 text-center">
                <span class="flex size-20 items-center justify-center rounded-full bg-cloud/60 text-slate"><sd-icon name="calendar-off" [size]="34" /></span>
                <p class="font-sans text-body-sm text-slate">No past visit</p>
              </div>
            } @else {
              <ul class="flex flex-col gap-4">
                @for (v of pastVisits(); track v.id) {
                  <li class="flex flex-col gap-3 rounded-card border border-cloud bg-white p-5 sm:flex-row sm:items-center sm:justify-between">
                    <div class="flex items-center gap-3">
                      <span class="flex size-11 shrink-0 items-center justify-center rounded-full bg-frost text-cerulean"><sd-icon name="stethoscope" [size]="18" /></span>
                      <div class="flex flex-col">
                        <span class="font-heading text-body font-semibold text-ink">{{ v.specialist.name }}</span>
                        <span class="font-sans text-caption text-slate">{{ v.specialist.specialty }}</span>
                      </div>
                    </div>
                    <div class="flex flex-col gap-1">
                      <span class="flex items-center gap-2 font-sans text-body-sm text-ink"><sd-icon name="calendar-days" [size]="16" class="text-slate" />{{ dateLabel(v.scheduled_at) }}</span>
                      <span class="flex items-center gap-2 font-sans text-body-sm text-ink"><sd-icon name="clock" [size]="16" class="text-slate" />{{ time(v.scheduled_at) }}</span>
                    </div>
                    <doc-visit-status-badge [status]="v.status" [label]="v.status_label" />
                  </li>
                }
              </ul>
            }
          }

          <!-- ===== Clinical tools (preserved authoring) ===== -->
          @case ('clinical') {
            <div class="grid grid-cols-1 gap-6 lg:grid-cols-[13.5rem_minmax(0,1fr)] lg:items-start">
              <!-- Sub-tabs: the primary tabs' pill bar (scrolls sideways on small screens), stacked into a rail on desktop. -->
              <nav class="min-w-0 lg:sticky lg:top-6" aria-label="Clinical tools">
                <div class="flex w-fit max-w-full gap-1 overflow-x-auto rounded-pill border border-cloud bg-white p-1 lg:w-full lg:flex-col lg:overflow-visible lg:rounded-card lg:p-2">
                  @for (t of tabs; track t.key) {
                    <button type="button" class="${SUB_TAB}"
                      [class]="tab() === t.key ? 'bg-frost text-cerulean' : 'text-slate hover:text-ink lg:hover:bg-glacier'"
                      [attr.aria-current]="tab() === t.key ? 'true' : null"
                      (click)="select(t.key)">
                      <sd-icon [name]="t.icon" [size]="16" class="shrink-0" />{{ t.label }}
                    </button>
                  }
                </div>
              </nav>

              <div class="flex min-w-0 flex-col gap-6">
                @switch (tab()) {
                  @case ('notes') {
                    <doc-clinical-note
                      [state]="noteState()"
                      [note]="note()"
                      [values]="noteValues()"
                      [loadError]="noteLoadError()"
                      [error]="sectionError()"
                      [saving]="savingNote()"
                      [savingMode]="noteSaveMode()"
                      (valueChange)="setNote($event.key, $event.value)"
                      (save)="saveNote($event)"
                      (retry)="reloadNote()"
                    />
                  }
                  @case ('messages') {
                    <doc-clinical-header icon="message-square" heading="Secure messages" helper="Async, non-urgent messages with the patient. Not for emergencies." />
                    <section class="rounded-card border border-cloud bg-white p-3 shadow-[0_1px_2px_rgba(10,22,40,0.04)] sm:p-4" aria-label="Message thread">
                      <div class="h-[58vh] min-h-[22rem]">
                        <sd-message-thread viewerRole="doctor" [messages]="messages()" [loading]="messagesLoading()" [sending]="sendingMessage()" placeholder="Message the patient…" emptyText="No messages yet. Send the first message to your patient." (send)="sendMessage($event)" />
                      </div>
                    </section>
                    @if (sectionError()) { <sd-alert tone="error">{{ sectionError() }}</sd-alert> }
                  }
                  @case ('prescriptions') {
                    <!-- Prescribe against this consultation (during or after the call). -->
                    <doc-rx-panel [patientId]="a.patient_id" [appointmentId]="id" />
                  }
                  @case ('labs') {
                    <doc-clinical-labs
                      [orders]="labOrders()"
                      [(tests)]="labTests"
                      [(priority)]="labPriority"
                      [(instructions)]="labInstructions"
                      [busy]="sectionBusy()"
                      [error]="sectionError()"
                      (placeOrder)="orderLab()"
                    />
                  }
                  @case ('care') {
                    <doc-clinical-care-plan
                      [items]="careItems()"
                      [plan]="carePlan()"
                      [busy]="sectionBusy()"
                      [error]="sectionError()"
                      (addStep)="addCare()"
                      (removeStep)="removeCare($event)"
                      (stepChange)="setCare($event.index, $event.value)"
                      (publish)="saveCare()"
                    />
                  }
                  @case ('referrals') {
                    <doc-clinical-referrals
                      [referrals]="referrals()"
                      [(type)]="refType"
                      [(priority)]="refPriority"
                      [(target)]="refTarget"
                      [(reason)]="refReason"
                      [(summary)]="refSummary"
                      [busy]="sectionBusy()"
                      [error]="sectionError()"
                      (create)="createReferral()"
                      (openDocument)="openDoc('referral', $event)"
                    />
                  }
                  @case ('certificates') {
                    <doc-clinical-certificates
                      [certificates]="certificates()"
                      [(type)]="certType"
                      [(diagnosis)]="certDiagnosis"
                      [(from)]="certFrom"
                      [(to)]="certTo"
                      [(statement)]="certStatement"
                      [busy]="sectionBusy()"
                      [error]="sectionError()"
                      (issue)="issueCertificate()"
                      (openDocument)="openDoc('certificate', $event)"
                    />
                  }
                  @case ('consents') {
                    <doc-clinical-consents [consents]="consents()" />
                  }
                  @case ('recording') {
                    <doc-clinical-recording
                      [state]="recording()"
                      [files]="recordingFiles()"
                      [busy]="sectionBusy()"
                      [error]="sectionError()"
                      (startRecording)="startRecording()"
                      (stopRecording)="stopRecording()"
                    />
                  }
                  @case ('ai') {
                    <doc-clinical-ai
                      [transcript]="transcript()"
                      [draft]="copilot()"
                      [busy]="sectionBusy()"
                      [error]="sectionError()"
                      (generate)="generateCopilot()"
                    />
                  }
                }
              </div>
            </div>
          }
        }
      } @else {
        <div class="sd-shimmer h-40 rounded-card"></div>
      }
    </div>

    <ng-template #unavailable>
      <div class="flex flex-col items-center gap-3 py-16 text-center">
        <span class="flex size-20 items-center justify-center rounded-full bg-cloud/60 text-slate"><sd-icon name="file-text" [size]="34" /></span>
        <p class="font-sans text-body-sm text-slate">Information unavailable</p>
      </div>
    </ng-template>

    <ng-template #recordFailed>
      <div class="flex flex-col items-center gap-3 rounded-card border border-cloud bg-white py-16 text-center">
        <sd-icon name="wifi-off" [size]="32" class="text-alert" />
        <p class="font-sans text-body-sm text-slate">{{ recordError() }}</p>
      </div>
    </ng-template>
  `,
})
export class DoctorAppointmentDetail implements OnInit {
  private readonly api = inject(DoctorApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly tabs = TABS;
  protected readonly primaryTabs: ReadonlyArray<{ key: PrimaryTab; label: string }> = [
    { key: 'overview', label: 'Overview' },
    { key: 'history', label: 'Medical History' },
    { key: 'documents', label: 'Documents' },
    { key: 'visits', label: 'Past Visits' },
    { key: 'clinical', label: 'Clinical tools' },
  ];
  protected readonly primary = signal<PrimaryTab>('overview');

  /** The appointment id (route param) — also the consultation the prescriptions belong to. */
  protected id = '';
  protected readonly appt = signal<DoctorAppointmentDto | null>(null);
  protected readonly apptError = signal('');
  /** Ticks so time-derived state (Join button, Past Visits) re-evaluates. */
  private readonly now = signal(Date.now());

  // Patient briefing
  protected readonly patientRecord = signal<DoctorPatientRecordDto | null>(null);
  protected readonly loadingRecord = signal(true);
  protected readonly recordError = signal('');
  protected readonly patientDocs = signal<MedicalDocumentDto[]>([]);
  protected readonly loadingDocs = signal(true);
  protected readonly docsError = signal('');
  protected readonly docSearch = signal('');

  protected readonly age = computed(() => this.ageFrom(this.patientRecord()?.patient?.date_of_birth));
  protected readonly medications = computed(() => this.patientRecord()?.medical?.medications ?? []);
  protected readonly conditions = computed(() => this.patientRecord()?.medical?.conditions ?? []);
  protected readonly allergies = computed(() => this.patientRecord()?.medical?.allergies ?? []);
  protected readonly pastHistory = computed(() => this.patientRecord()?.medical?.history ?? []);
  protected readonly pastVisits = computed(() =>
    (this.patientRecord()?.appointments ?? []).filter(
      (a) => a.id !== this.id && new Date(a.scheduled_at).getTime() < this.now(),
    ),
  );
  protected readonly filteredDocs = computed(() => {
    const q = this.docSearch().trim().toLowerCase();
    const docs = this.patientDocs();
    return q ? docs.filter((d) => d.title.toLowerCase().includes(q) || d.type_label.toLowerCase().includes(q)) : docs;
  });

  /** The Join-call button's label + enabled state, from time-to-start. */
  protected readonly joinState = computed<{ label: string; enabled: boolean }>(() => {
    const a = this.appt();
    if (!a) return { label: 'Join Call', enabled: false };
    if (a.status === 'completed' || a.status === 'cancelled') return { label: 'Consultation ended', enabled: false };
    const mins = Math.round((new Date(a.scheduled_at).getTime() - this.now()) / 60000);
    if (mins > 5) return { label: `Join Call in ${mins}mins time`, enabled: false };
    return { label: 'Join Call Now', enabled: true };
  });

  // Lifecycle actions
  protected readonly actionBusy = signal(false);
  protected readonly actionError = signal('');
  protected readonly rescheduleOpen = signal(false);
  protected readonly rescheduleAt = signal('');

  // Clinical tools (nested)
  protected readonly tab = signal<TabKey>('notes');
  private readonly loaded = new Set<TabKey>();
  protected readonly sectionBusy = signal(false);
  protected readonly sectionError = signal('');

  protected readonly note = signal<ClinicalNoteDto | null>(null);
  /**
   * The saved note's load state. The editor (and Save / Finalize) only appear
   * once it is 'ready', so a blank editor can never overwrite a saved note.
   */
  protected readonly noteState = signal<'idle' | 'loading' | 'ready' | 'error'>('idle');
  protected readonly noteLoadError = signal('');
  private readonly noteDraft = signal<Record<string, string>>({ subjective: '', objective: '', assessment: '', plan: '' });
  protected readonly noteValues = this.noteDraft.asReadonly();
  protected readonly savingNote = signal(false);
  /** Which note button started the in-flight save (only drives its spinner). */
  protected readonly noteSaveMode = signal<NoteSaveMode | null>(null);
  protected readonly finalized = computed(() => this.note()?.status === 'finalized');

  protected readonly messages = signal<MessageDto[]>([]);
  protected readonly messagesLoading = signal(false);
  protected readonly sendingMessage = signal(false);

  protected readonly labOrders = signal<LabOrderDto[]>([]);
  protected readonly labTests = signal('');
  protected readonly labPriority = signal<'routine' | 'urgent'>('routine');
  protected readonly labInstructions = signal('');

  protected readonly careItems = signal<string[]>([]);
  /** The last loaded / published care plan (published state + who / when) — display only. */
  protected readonly carePlan = signal<CarePlanDto | null>(null);

  protected readonly referrals = signal<ReferralDto[]>([]);
  protected readonly refType = signal<ReferralDto['referral_type']>('specialist');
  protected readonly refTarget = signal('');
  protected readonly refReason = signal('');
  protected readonly refSummary = signal('');
  protected readonly refPriority = signal<'routine' | 'urgent'>('routine');

  protected readonly certificates = signal<MedicalCertificateDto[]>([]);
  protected readonly certType = signal<MedicalCertificateDto['type']>('sick_leave');
  protected readonly certStatement = signal('');
  protected readonly certDiagnosis = signal('');
  protected readonly certFrom = signal('');
  protected readonly certTo = signal('');

  protected readonly consents = signal<ConsentDto[]>([]);
  protected readonly recording = signal<DoctorRecordingStateDto | null>(null);
  protected readonly recordingFiles = signal<RecordingFileDto[]>([]);
  protected readonly transcript = signal<TranscriptSegmentDto[]>([]);
  protected readonly copilot = signal<CopilotDraftDto | null>(null);

  constructor() {
    // Load a Clinical tools sub-tab whenever it becomes VISIBLE — including the
    // default Notes sub-tab when the Clinical tools tab itself is opened.
    effect(() => {
      if (this.primary() !== 'clinical') return;
      const tab = this.tab();
      untracked(() => this.ensureLoaded(tab));
    });
  }

  ngOnInit(): void {
    this.id = this.route.snapshot.paramMap.get('id') ?? '';

    // Keep time-derived UI (Join button countdown, Past Visits) fresh without a
    // reload — a memoized computed only re-runs when a signal it reads changes.
    const tick = setInterval(() => this.now.set(Date.now()), 30_000);
    this.destroyRef.onDestroy(() => clearInterval(tick));

    this.api
      .schedule()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          const found = res.data.appointments.find((a) => a.id === this.id) ?? null;
          if (found) {
            this.appt.set(found);
            this.loadRecord(found.patient_id);
          } else this.apptError.set('Appointment not found.');
        },
        error: (err: unknown) => this.apptError.set(apiErrorMessage(err, 'Could not load the appointment.')),
      });

    this.docsError.set('');
    this.api
      .patientDocuments(this.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.patientDocs.set(r.data); this.loadingDocs.set(false); },
        error: (err: unknown) => {
          this.docsError.set(apiErrorMessage(err, "Could not load the patient's documents."));
          this.loadingDocs.set(false);
        },
      });
  }

  private loadRecord(patientId: string): void {
    this.recordError.set('');
    this.api
      .patient(patientId)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => { this.patientRecord.set(r.data); this.loadingRecord.set(false); },
        error: (err: unknown) => {
          this.recordError.set(apiErrorMessage(err, "Could not load the patient's record."));
          this.loadingRecord.set(false);
        },
      });
  }

  protected openPatientDoc(doc: MedicalDocumentDto): void {
    // Popup-safe: open the tab synchronously on the click, then swap in the blob
    // once the bytes arrive (a post-await window.open is blocked by Safari etc.).
    openBlobDocument(this.api.patientDocumentBlob(this.id, doc.id));
  }

  protected select(tab: TabKey): void {
    this.tab.set(tab);
    this.sectionError.set('');
    // Re-clicking the open tab retries a failed load (the effect only sees changes).
    this.ensureLoaded(tab);
  }

  /** Load a sub-tab's data once (a failed load is forgotten, so it retries). */
  private ensureLoaded(tab: TabKey): void {
    if (this.loaded.has(tab)) return;
    this.loaded.add(tab);
    this.loadTab(tab);
  }

  private loadTab(tab: TabKey): void {
    switch (tab) {
      case 'notes':
        this.loadNote();
        break;
      case 'messages':
        this.messagesLoading.set(true);
        this.api.messages(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => { this.messages.set(r.data); this.messagesLoading.set(false); }, error: (err: unknown) => { this.messagesLoading.set(false); this.tabLoadFailed('messages', err, 'Could not load the messages.'); } });
        break;
      // 'prescriptions': <doc-rx-panel> loads (and refreshes) its own list.
      case 'labs':
        this.api.listLabOrders(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.labOrders.set(r.data), error: () => undefined });
        break;
      case 'care':
        // Not silent: an empty editor after a failed load would let "Publish" overwrite the real plan.
        this.api.getCarePlan(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => { this.careItems.set(r.data.items ?? []); this.carePlan.set(r.data); }, error: (err: unknown) => this.tabLoadFailed('care', err, 'Could not load the care plan.') });
        break;
      case 'referrals':
        this.api.listReferrals(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.referrals.set(r.data), error: () => undefined });
        break;
      case 'certificates':
        this.api.listCertificates(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.certificates.set(r.data), error: () => undefined });
        break;
      case 'consents':
        this.api.consents(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.consents.set(r.data), error: () => undefined });
        break;
      case 'recording':
        this.api.recordingState(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.recording.set(r.data), error: () => undefined });
        this.api.recordingFiles(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.recordingFiles.set(r.data.files), error: () => undefined });
        break;
      case 'ai':
        this.api.transcript(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.transcript.set(r.data), error: () => undefined });
        this.api.copilot(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.copilot.set(r.data.draft), error: () => undefined });
        break;
    }
  }

  /**
   * A clinical tab's initial load failed: show the real error (only if that tab
   * is still open) and forget it was loaded, so re-selecting the tab retries.
   */
  private tabLoadFailed(tab: TabKey, err: unknown, fallback: string): void {
    this.loaded.delete(tab);
    if (this.tab() === tab) this.sectionError.set(apiErrorMessage(err, fallback));
  }

  // ----- Notes -----
  private loadNote(): void {
    this.noteState.set('loading');
    this.noteLoadError.set('');
    this.api.getNote(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (r) => {
        this.note.set(r.data);
        this.noteDraft.set({ subjective: r.data.subjective ?? '', objective: r.data.objective ?? '', assessment: r.data.assessment ?? '', plan: r.data.plan ?? '' });
        this.noteState.set('ready');
      },
      error: (err: unknown) => {
        this.loaded.delete('notes');
        this.noteLoadError.set(apiErrorMessage(err, 'Could not load the clinical note. Please try again.'));
        this.noteState.set('error');
      },
    });
  }
  protected reloadNote(): void { this.ensureLoaded('notes'); }
  protected setNote(key: string, value: string): void { this.noteDraft.update((d) => ({ ...d, [key]: value })); }
  protected saveNote(finalize: boolean): void {
    // Never save over a note that has not loaded (it would replace the saved copy).
    if (this.noteState() !== 'ready' || this.savingNote()) return;
    this.savingNote.set(true); this.sectionError.set('');
    this.noteSaveMode.set(finalize ? 'finalize' : 'draft');
    const d = this.noteDraft();
    const input = { subjective: d['subjective'], objective: d['objective'], assessment: d['assessment'], plan: d['plan'] };
    const call = finalize ? this.api.finalizeNote(this.id, input) : this.api.saveNote(this.id, input);
    call.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => { this.note.set(r.data); this.savingNote.set(false); }, error: (err: unknown) => { this.sectionError.set(apiErrorMessage(err, 'Could not save the note.')); this.savingNote.set(false); } });
  }

  // ----- Messages -----
  protected sendMessage(body: string): void {
    this.sendingMessage.set(true); this.sectionError.set('');
    this.api.sendMessage(this.id, body).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => { this.messages.update((list) => [...list, r.data]); this.sendingMessage.set(false); }, error: (err) => { this.sectionError.set(apiErrorMessage(err, 'Could not send the message.')); this.sendingMessage.set(false); } });
  }

  // ----- Labs -----
  protected orderLab(): void {
    const tests = this.labTests().split('\n').map((t) => t.trim()).filter(Boolean);
    if (tests.length === 0) { this.sectionError.set('Add at least one test.'); return; }
    this.runSection(this.api.createLabOrder(this.id, { tests, priority: this.labPriority(), instructions: this.labInstructions() || null }), () => {
      this.labTests.set(''); this.labInstructions.set('');
      this.api.listLabOrders(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.labOrders.set(r.data), error: () => undefined });
    }, 'Could not place the lab order.');
  }

  // ----- Care plan -----
  protected addCare(): void { this.careItems.update((list) => [...list, '']); }
  protected removeCare(i: number): void { this.careItems.update((list) => list.filter((_, idx) => idx !== i)); }
  protected setCare(i: number, value: string): void { this.careItems.update((list) => list.map((v, idx) => (idx === i ? value : v))); }
  protected saveCare(): void {
    const items = this.careItems().map((v) => v.trim()).filter(Boolean);
    this.runSection(this.api.saveCarePlan(this.id, items), (r) => {
      const plan = r.data as CarePlanDto;
      this.careItems.set(plan.items ?? items);
      this.carePlan.set(plan);
    }, 'Could not publish the care plan.');
  }

  // ----- Referrals -----
  protected createReferral(): void {
    if (this.refTarget().trim() === '' || this.refReason().trim() === '') { this.sectionError.set('Please complete the referral.'); return; }
    this.runSection(this.api.createReferral(this.id, { referral_type: this.refType(), target: this.refTarget(), reason: this.refReason(), clinical_summary: this.refSummary() || null, priority: this.refPriority() }), () => {
      this.refTarget.set(''); this.refReason.set(''); this.refSummary.set('');
      this.api.listReferrals(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.referrals.set(r.data), error: () => undefined });
    }, 'Could not create the referral.');
  }

  // ----- Certificates + documents -----
  protected issueCertificate(): void {
    if (this.certStatement().trim() === '') { this.sectionError.set('Add a certifying statement.'); return; }
    if (this.certType() === 'sick_leave' && (this.certFrom() === '' || this.certTo() === '')) { this.sectionError.set('Set the leave period.'); return; }
    this.runSection(this.api.createCertificate(this.id, { type: this.certType(), statement: this.certStatement(), diagnosis: this.certDiagnosis() || null, from_date: this.certType() === 'sick_leave' ? this.certFrom() : null, to_date: this.certType() === 'sick_leave' ? this.certTo() : null }), () => {
      this.certStatement.set(''); this.certDiagnosis.set(''); this.certFrom.set(''); this.certTo.set('');
      this.api.listCertificates(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.certificates.set(r.data), error: () => undefined });
    }, 'Could not issue the certificate.');
  }

  protected openDoc(kind: ClinicalDocumentKind, docId: string): void {
    openClinicalDocument(this.api.document(this.id, kind, docId));
  }

  // ----- Recording -----
  protected startRecording(): void {
    this.runSection(this.api.startRecording(this.id), () => this.api.recordingState(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.recording.set(r.data), error: () => undefined }), 'Could not start recording — check the patient has granted recording consent.');
  }
  protected stopRecording(): void {
    this.runSection(this.api.stopRecording(this.id), () => {
      this.api.recordingState(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.recording.set(r.data), error: () => undefined });
      this.api.recordingFiles(this.id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (r) => this.recordingFiles.set(r.data.files), error: () => undefined });
    }, 'Could not stop the recording.');
  }

  // ----- AI -----
  protected generateCopilot(): void {
    this.runSection(this.api.generateCopilot(this.id), (r) => this.copilot.set(r.data as CopilotDraftDto), 'Could not generate a draft — AI or transcription consent may be unavailable.');
  }

  private runSection<T>(call: Observable<T>, onSuccess: (res: T) => void, errorMessage = 'Something went wrong. Please try again.'): void {
    // One section call at a time: a disabled <sd-button> still lets a click
    // reach its host element, so its look alone can't stop a double submit.
    if (this.sectionBusy()) return;
    this.sectionBusy.set(true); this.sectionError.set('');
    call.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({ next: (res) => { onSuccess(res); this.sectionBusy.set(false); }, error: (err: unknown) => { this.sectionError.set(apiErrorMessage(err, errorMessage)); this.sectionBusy.set(false); } });
  }

  protected join(a: DoctorAppointmentDto): void {
    const marker = '/call/join/';
    const idx = a.join_url.indexOf(marker);
    const token = idx >= 0 ? a.join_url.slice(idx + marker.length) : '';
    if (token) void this.router.navigate(['/call', token]);
    else window.location.href = a.join_url;
  }

  // ----- Lifecycle actions -----
  protected canReschedule(s: string): boolean { return ['pending', 'confirmed', 'rescheduled'].includes(s); }
  protected canCancel(s: string): boolean { return ['pending', 'confirmed', 'rescheduled'].includes(s); }
  protected toggleReschedule(): void { this.rescheduleOpen.update((v) => !v); this.actionError.set(''); }
  protected confirm(): void { this.runAction(this.api.confirm(this.id)); }
  protected decline(): void {
    if (!window.confirm('Cancel this appointment? Any payment will be refunded to the patient.')) return;
    this.runAction(this.api.decline(this.id));
  }
  protected submitReschedule(): void {
    if (this.rescheduleAt().trim() === '') { this.actionError.set('Choose a new date and time.'); return; }
    this.runAction(this.api.reschedule(this.id, new Date(this.rescheduleAt()).toISOString()), () => this.rescheduleOpen.set(false));
  }
  private runAction(call: Observable<SuccessResponse<AppointmentDto>>, onOk?: () => void): void {
    this.actionBusy.set(true); this.actionError.set('');
    call.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => { this.appt.update((a) => (a ? { ...a, status: res.data.status, status_label: res.data.status_label, scheduled_at: res.data.scheduled_at } : a)); this.actionBusy.set(false); onOk?.(); },
      error: (err) => { this.actionError.set(apiErrorMessage(err, 'Could not update the appointment.')); this.actionBusy.set(false); },
    });
  }

  // ----- Helpers -----
  protected initialsFor(name: string): string { return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase(); }
  protected money(amount: string): string { const n = Number(amount); return '₦' + (isNaN(n) ? '0' : n.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })); }
  protected dateLabel(iso: string): string { return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso)); }
  protected time(iso: string): string { return new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit' }).format(new Date(iso)); }
  protected shortDate(iso: string): string { return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso)); }
  private ageFrom(dob: string | null | undefined): number | null {
    if (!dob) return null;
    const d = new Date(dob);
    if (isNaN(d.getTime())) return null;
    const now = new Date();
    let age = now.getFullYear() - d.getFullYear();
    const m = now.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
    return age >= 0 && age < 130 ? age : null;
  }
}
