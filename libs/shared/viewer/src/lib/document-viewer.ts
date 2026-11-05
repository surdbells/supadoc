import { DOCUMENT, NgTemplateOutlet } from '@angular/common';
import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  NgZone,
  output,
  signal,
  untracked,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { DialogService, IconComponent } from '@supadoc/ui';
import { catchError, defaultIfEmpty, EMPTY, map, Observable, of, Subject, type Subscription, switchMap, take } from 'rxjs';
import { mediaUrl, type MediaUrl } from './media-url';
import { isPasswordError, PDF_LOADER, type PdfDocumentLike, type PdfLoadingTaskLike, type PdfPageLike, type PdfRenderTaskLike } from './pdf-loader';
import {
  buildPrintRoot,
  composePrintPage,
  MAX_PRINT_PAGES,
  PRINT_FAILED,
  PRINT_IMAGE_MAX_PX,
  PRINT_PAGE_CSS_PX,
  PRINT_TOO_LONG,
  PrintTooLongError,
  type PreparedPrint,
} from './print-pages';
import { saveBlob } from './save-file';
import { TEXT_LAYER_CSS, TEXT_LAYER_RENDERER, type TextLayerJob } from './text-layer';
import { applyViewerTokens, pageTheme, resolveTone, viewerTokens } from './theme-observer';
import * as copy from './viewer-copy';
import { PinchTracker, scrollAfterZoom, wheelFactor, type Point } from './viewer-gestures';
import { provideViewerIcons } from './viewer-icons';
import { viewerKind } from './viewer-kind';
import { reducedMotion, viewerLayout } from './viewer-layout';
import { isViewerPolicyId, sourceProblem, VIEWER_POLICIES, type ViewerPolicy } from './viewer-policy';
import { defaultErrorView, safeFilename } from './viewer-sources';
import type {
  ViewerErrorView,
  ViewerFile,
  ViewerInsets,
  ViewerKind,
  ViewerResumeState,
  ViewerSource,
  ViewerState,
  ViewerTone,
  ViewerWatermark,
} from './viewer-types';
import {
  clampZoom,
  MAX_CANVAS_AREA,
  MENU_ZOOMS,
  nextZoom,
  PDF_TO_CSS,
  renderScale,
  rotatedSize,
  stagePadding,
  type ZoomMode,
  zoomFor,
  zoomPercent,
} from './viewer-zoom';
import { ViewerThumbnailsComponent } from './viewer-thumbnails';
import { drawWatermark, overlayLines, printFooterText, watermarkText } from './watermark';

/** Moving through a list: `load()` waits until navigation has settled this long (§1.7). */
export const NAV_DEBOUNCE_MS = 400;
/** Gesture zoom (pinch / Ctrl+wheel): pages are redrawn sharp this long after it stops. */
const GESTURE_SETTLE_MS = 150;
/** A page change by scrolling is announced after this long without scrolling. */
const SCROLL_ANNOUNCE_MS = 1000;
/** Pages further than this from the visible ones are released. */
const KEEP_AROUND = 3;
/** Images on screen: at most this many device pixels on the long side, × DPR. */
const SCREEN_IMAGE_MAX_PX = 4096;
export const PAGES_KEY = 'sd-viewer:pages';
export const KEYS_KEY = 'sd-viewer:keys';

type Shown =
  | 'refused'
  | 'revoked'
  | 'loading'
  | 'error'
  | 'gone'
  | 'reload'
  | 'not_viewable'
  | 'password'
  | 'cant_show'
  | 'video_error'
  | 'pdf'
  | 'image'
  | 'video';
type ToolId = 'pages' | 'zoomOut' | 'zoom' | 'zoomIn' | 'rotate' | 'prevPage' | 'page' | 'nextPage' | 'print' | 'download' | 'fullscreen' | 'keys' | 'more';
type Panel = 'zoom' | 'page' | 'keys' | 'more' | null;
interface Tool {
  readonly id: ToolId;
  readonly label: string;
  readonly icon?: string;
  readonly text?: string;
  readonly pressed?: boolean;
  readonly disabled: boolean;
  readonly sep?: boolean;
  readonly popup?: 'menu' | 'dialog';
}
interface MenuItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: string;
  readonly checked?: boolean;
}

/** Instances in mount order: only the last connected one answers window Ctrl/Cmd+P. */
const ACTIVE: DocumentViewerComponent[] = [];
let nextSeq = 0;

function readStore(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function writeStore(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* private mode / blocked storage: not remembered */
  }
}

function readBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/**
 * One value after `ms` (cancelled on unsubscribe). Not rxjs `timer`: shared by
 * several lazy chunks, that operator and its scheduler land in the initial bundle.
 */
function after(ms: number): Observable<0> {
  return new Observable<0>((sub) => {
    const t = setTimeout(() => {
      sub.next(0);
      sub.complete();
    }, ms);
    return () => clearTimeout(t);
  });
}

function isField(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}

function inMenu(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && !!el.closest('[role="menu"],[role="dialog"].sdv-panel');
}

/*
 * Tailwind scans this file (comments included): a CSS keyword here that is also
 * a utility name (the eased timing keywords, say) adds that utility to every
 * app's initial CSS, so timing functions are written as cubic-bezier(). In
 * modal mode the host fills the outlet's content area (`.sdv-modal`);
 * embedded hosts size it.
 */
const BODY_CSS = `
sd-document-viewer{display:flex;flex-direction:column;min-height:0;min-width:0;position:relative;color:var(--sd-viewer-text);background:var(--sd-viewer-chrome)}
sd-document-viewer.sdv-modal{flex:1 1 0%}
@media print{sd-document-viewer{display:none!important}}
.sdv-deter{-webkit-touch-callout:none;-webkit-user-drag:none}
.sdv-c{background:var(--sd-viewer-chrome)}
.sdv-s{background:var(--sd-viewer-stage)}
.sdv-l{border-color:var(--sd-viewer-border)}
.sdv-muted{color:var(--sd-viewer-muted)}
.sdv-p,.sdv-btn[aria-pressed=true],.sdv-btn[aria-expanded=true],.sdv-item[aria-checked=true]{background:var(--sd-viewer-pressed-bg);color:var(--sd-viewer-pressed-fg)}
.sdv-bar{min-height:52px}
.sdv-bar--bottom{order:3;min-height:56px;padding:4px max(8px,env(safe-area-inset-right)) max(4px,env(safe-area-inset-bottom)) max(8px,env(safe-area-inset-left))}
.sdv-bar--side{width:52px;padding-right:env(safe-area-inset-right)}
.sdv-sep{margin:0 4px;background:var(--sd-viewer-border)}
.sdv-btn{color:var(--sd-viewer-control)}
.sdv-btn:hover,.sdv-item:hover,.sdv-item:focus{background:var(--sd-viewer-hover);color:var(--sd-viewer-text)}
.sdv-btn[aria-disabled=true]{opacity:.45;cursor:not-allowed}
.sdv-root :is(button,input,[tabindex]):focus-visible{outline:2px solid var(--sd-viewer-ring);outline-offset:2px}
.sdv-stage{touch-action:pan-x pan-y}
.sdv-stage--pan{cursor:grab}
.sdv-stage--panning{cursor:grabbing}
.sdv-col,.sdv-image{padding:var(--sdv-pad,16px);width:max-content;min-width:100%;box-sizing:border-box}
.sdv-page{background:var(--sd-viewer-page);--user-unit:1;--total-scale-factor:calc(var(--scale-factor) * var(--user-unit));--scale-round-x:1px;--scale-round-y:1px}
.sdv-page canvas{display:block;width:100%;height:100%}
.sdv-image canvas{display:block;background:var(--sd-viewer-page)}
.sdv-video{margin:16px auto;background:#000}
.sdv-video video{display:block;width:100%;max-height:70dvh}
.sdv-wm{opacity:.14;color:#fff;text-shadow:0 0 2px #000}
.sdv-wm span{white-space:nowrap;transform:rotate(-30deg)}
.sdv-skel i{display:block;width:min(34rem,82%);aspect-ratio:1/1.414;border-radius:4px;background:var(--sd-viewer-skeleton);animation:sdv-pulse 1.4s cubic-bezier(.42,0,.58,1) infinite}
.sdv-skel i.sdv-skel--img{aspect-ratio:4/3}
@keyframes sdv-pulse{50%{opacity:.55}}
.sdv-alert{background:var(--sd-viewer-danger-soft);color:var(--sd-viewer-danger-text)}
.sdv-banner{background:var(--sd-viewer-warn-soft);color:var(--sd-viewer-warn-text)}
.sdv-banner .sdv-btn{color:inherit;border:1px solid}
.sdv-rail--overlay{animation:sdv-slide .16s cubic-bezier(0,0,.58,1)}
@keyframes sdv-slide{from{transform:translateX(-100%)}}
.sdv-panel{min-width:200px;max-width:min(22rem,calc(100% - 16px));max-height:min(28rem,70dvh)}
.sdv-field{border:1px solid var(--sd-viewer-muted);background:var(--sd-viewer-chrome);color:inherit}
.sdv-keys td{padding:4px 8px;border-top:1px solid var(--sd-viewer-border)}
.sdv-switch{background:var(--sd-viewer-muted)}
.sdv-switch[aria-checked=true]{background:var(--sd-viewer-ring)}
@media (prefers-reduced-motion:reduce){.sdv-skel i,.sdv-rail--overlay{animation:none}}
`;

/**
 * The shared viewer's body (`sd-document-viewer`, `@supadoc/viewer/embed`):
 * PDF pages, photos and videos from a {@link ViewerSource}, with zoom,
 * rotation, a page rail, keyboard shortcuts, Print and Download as the
 * source's policy allows (§1.4–§1.8, §2.2). It generalises the doctor's
 * view-only viewer (TZ §4): `view_only` keeps every deterrent, the watermark
 * on every raster and the recorded print; every other policy gets a pdf.js
 * text layer, and Download where allowed.
 *
 * Modal hosts never use it directly: `DocumentViewerService.open()` mounts the
 * outlet, which renders this. The back office embeds it (`mode="embedded"`).
 */
@Component({
  selector: 'sd-document-viewer',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [IconComponent, NgTemplateOutlet, ViewerThumbnailsComponent],
  providers: [provideViewerIcons()],
  styles: [BODY_CSS, TEXT_LAYER_CSS],
  host: {
    '[attr.data-layout]': 'layout()',
    '[class.sdv-modal]': "mode() === 'modal'",
    '(window:keydown)': 'onWindowKey($event)',
    '(document:fullscreenchange)': 'onFullscreenChange()',
    '(document:webkitfullscreenchange)': 'onFullscreenChange()',
  },
  template: `
    <div
      #root
      class="sdv-root relative flex min-h-0 flex-1 flex-col"
      tabindex="-1"
      [class.sdv-deter]="policy().deterrents"
      [class.select-none]="policy().deterrents"
      (contextmenu)="deter($event)"
      (dragstart)="deter($event)"
      (copy)="deter($event)"
      (cut)="deter($event)"
    >
      @if (toolbarShown() && barPlace() !== 'side') {
        <ng-container [ngTemplateOutlet]="toolbarTpl" />
      }
      @if (printError()) {
        <p class="sdv-alert mx-3 mt-2 flex items-start gap-2 rounded-field px-3 py-2 font-sans text-caption" role="alert"><sd-icon name="circle-alert" [size]="14" />{{ printError() }}</p>
      }
      @if (downloadError()) {
        <p class="sdv-alert mx-3 mt-2 flex items-start gap-2 rounded-field px-3 py-2 font-sans text-caption" role="alert"><sd-icon name="circle-alert" [size]="14" />{{ downloadError() }}</p>
      }
      <div class="flex min-h-0 min-w-0 flex-1">
        @if (railShown() && railPlace() === 'side') {
          <sd-viewer-thumbnails class="sdv-rail sdv-c sdv-l w-44 shrink-0 overflow-y-auto border-r" [pdf]="thumbPdf()" [count]="pageCount()" [current]="currentPage()" [rotation]="rotation()" [aspect]="firstAspect()" [watermark]="thumbWatermark()" [hideContent]="covered()" (pick)="goTo($event, true)" />
        }
        <div class="sdv-s relative flex min-h-0 min-w-0 flex-1 flex-col">
          @if (bannerShown()) {
            <div class="sdv-banner sdv-l flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2 font-sans text-caption" role="status">
              <sd-icon name="triangle-alert" [size]="16" />
              <span class="min-w-0 flex-1">{{ bannerText() }}</span>
              <button type="button" class="sdv-btn inline-flex h-9 items-center rounded-field px-3 font-sans text-caption font-semibold" (click)="stopSharing.emit()">{{ c.STOP_SHARING }}</button>
            </div>
          }
          <div
            #scroller
            class="sdv-stage relative min-h-0 flex-1 overflow-auto overscroll-contain"
            tabindex="0"
            role="region"
            [class.sdv-stage--pan]="pannable()"
            [class.sdv-stage--panning]="panning()"
            [style.--sdv-pad.px]="padding()"
            [attr.aria-label]="source().title + ', document'"
            [attr.aria-busy]="shown() === 'loading' || rendering() || null"
            (dblclick)="onDoubleClick($event)"
          >
            @switch (shown()) {
              @case ('loading') {
                <div class="sdv-skel flex flex-col items-center gap-4 px-4 py-6">
                  @if (imageHint()) {
                    <i class="sdv-skel--img"></i>
                  } @else {
                    <i></i><i></i>
                  }
                  <p class="sdv-muted font-sans text-body-sm" role="status">{{ c.OPENING }}</p>
                </div>
              }
              @case ('pdf') {
                <div #column class="sdv-col flex flex-col items-center gap-4" [style.visibility]="covered() ? 'hidden' : null">
                  @for (p of pageNumbers(); track p) {
                    <div
                      class="sdv-page relative shrink-0 shadow-card"
                      [attr.data-page]="p"
                      [style.width.px]="holderWidth(p)"
                      [style.height.px]="holderHeight(p)"
                      [style.--scale-factor]="cssScale()"
                      [attr.role]="policy().textLayer ? 'group' : null"
                      [attr.aria-label]="policy().textLayer ? c.pageOf(p, pageCount()) : null"
                    >
                      <canvas
                        [attr.role]="canvasRole(p)"
                        [attr.aria-label]="canvasLabel(p)"
                        [attr.aria-hidden]="canvasRole(p) ? null : 'true'"
                      ></canvas>
                      @if (policy().textLayer) {
                        <div class="sd-text-layer" [attr.data-text]="p"></div>
                      }
                    </div>
                  }
                </div>
              }
              @case ('image') {
                <div class="sdv-image flex items-start justify-center" [style.visibility]="covered() ? 'hidden' : null">
                  <canvas #imageCanvas role="img" [attr.aria-label]="source().title" [style.width.px]="imageCss().width" [style.height.px]="imageCss().height"></canvas>
                </div>
              }
              @case ('video') {
                <div class="sdv-video relative max-w-5xl overflow-hidden rounded-card" [style.visibility]="covered() ? 'hidden' : null">
                  <video
                    #video
                    controls
                    playsinline
                    disablepictureinpicture
                    disableremoteplayback
                    preload="metadata"
                    [attr.controlslist]="policy().nativeVideoFullscreen ? 'nodownload noremoteplayback' : 'nodownload noremoteplayback noplaybackrate nofullscreen'"
                    [attr.aria-label]="source().title"
                    (error)="onVideoError()"
                    (dblclick)="policy().deterrents && $event.preventDefault()"
                    (webkitbeginfullscreen)="onWebkitVideoFullscreen()"
                  ></video>
                  @if (policy().watermark) {
                    <div class="sdv-wm pointer-events-none absolute inset-0 flex flex-col justify-around overflow-hidden font-sans text-body-sm font-semibold" aria-hidden="true">
                      @for (line of overlay(); track $index) {
                        <span>{{ line }}</span>
                      }
                    </div>
                  }
                </div>
              }
              @default {
                <div class="sdv-card sdv-c sdv-l mx-auto mt-12 flex max-w-md flex-col items-center gap-3 rounded-card border px-6 py-6 text-center">
                  @switch (shown()) {
                    @case ('not_viewable') {
                      <span class="sdv-p flex size-12 items-center justify-center rounded-xl font-sans text-caption font-semibold">{{ extLabel() || '?' }}</span>
                    }
                    @case ('video_error') {
                      <span class="sdv-p flex size-12 items-center justify-center rounded-xl font-sans text-caption font-semibold">{{ extLabel() || '?' }}</span>
                    }
                    @case ('gone') {
                      <sd-icon name="eye-off" [size]="28" class="sdv-muted" />
                    }
                    @case ('revoked') {
                      <sd-icon name="eye-off" [size]="28" class="sdv-muted" />
                    }
                    @case ('reload') {
                      <sd-icon name="refresh-cw" [size]="28" class="sdv-muted" />
                    }
                    @case ('password') {
                      <sd-icon name="lock" [size]="28" class="sdv-muted" />
                    }
                    @default {
                      <sd-icon name="triangle-alert" [size]="28" class="sdv-muted" />
                    }
                  }
                  <p class="font-sans text-body-sm" [attr.role]="cardRole()">{{ cardText() }}</p>
                  @if (cardAction(); as a) {
                    <button type="button" class="sdv-btn sdv-p inline-flex h-10 items-center justify-center rounded-field px-4 font-sans text-body-sm font-semibold" (click)="runCardAction(a.id)">{{ a.label }}</button>
                  }
                </div>
              }
            }
          </div>
          @if (covered()) {
            <div class="sdv-cover sdv-s absolute inset-0 z-10 flex items-center justify-center p-4">
              <div class="sdv-c sdv-l flex max-w-md flex-col items-center gap-3 rounded-card border px-6 py-6 text-center" role="group" [attr.aria-label]="c.SHARE_COVER_TITLE">
                <sd-icon name="eye-off" [size]="28" class="sdv-muted" />
                <p class="font-heading text-body font-semibold">{{ c.SHARE_COVER_TITLE }}</p>
                <p class="sdv-muted font-sans text-body-sm">{{ c.shareCoverText(recording()) }}</p>
                <div class="flex flex-wrap justify-center gap-2">
                  <button type="button" class="sdv-btn sdv-p inline-flex h-10 items-center justify-center rounded-field px-4 font-sans text-body-sm font-semibold" (click)="stopSharing.emit()">{{ c.STOP_SHARING }}</button>
                  <button type="button" class="sdv-btn inline-flex h-10 items-center justify-center rounded-field px-4 font-sans text-body-sm font-semibold" (click)="showAnyway()">{{ c.SHOW_ANYWAY }}</button>
                </div>
              </div>
            </div>
          }
          @if (railShown() && railPlace() === 'overlay') {
            <sd-viewer-thumbnails class="sdv-rail sdv-rail--overlay sdv-c sdv-l absolute inset-y-0 left-0 z-20 w-44 overflow-y-auto border-r shadow-overlay" [pdf]="thumbPdf()" [count]="pageCount()" [current]="currentPage()" [rotation]="rotation()" [aspect]="firstAspect()" [watermark]="thumbWatermark()" [hideContent]="covered()" (pick)="goTo($event, true); railOpen.set(false)" />
          }
          @if (sheetOpen()) {
            <div class="sdv-sheet sdv-c absolute inset-0 z-20 flex flex-col" role="dialog" [attr.aria-label]="c.PAGES">
              <div class="flex items-center gap-2 px-3 py-2">
                <ng-container [ngTemplateOutlet]="goToTpl" />
                <span class="flex-1"></span>
                <button type="button" class="sdv-btn inline-flex size-11 items-center justify-center rounded-field" [attr.aria-label]="c.HIDE_PAGES" (click)="closeSheet()"><sd-icon name="x" [size]="20" /></button>
              </div>
              <div class="min-h-0 flex-1 overflow-y-auto">
                <sd-viewer-thumbnails [grid]="true" [pdf]="thumbPdf()" [count]="pageCount()" [current]="currentPage()" [rotation]="rotation()" [aspect]="firstAspect()" [watermark]="thumbWatermark()" [hideContent]="covered()" (pick)="goTo($event, true); closeSheet()" />
              </div>
            </div>
          }
        </div>
        @if (toolbarShown() && barPlace() === 'side') {
          <ng-container [ngTemplateOutlet]="toolbarTpl" />
        }
      </div>
      <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">{{ announcement() }}</p>
    </div>

    <ng-template #toolbarTpl>
      <div
        #bar
        tabindex="-1"
        class="sdv-bar sdv-c sdv-l relative flex items-center gap-0.5"
        [class.sdv-bar--bottom]="barPlace() === 'bottom'"
        [class.sdv-bar--side]="barPlace() === 'side'"
        [class.border-b]="barPlace() === 'top'"
        [class.px-2]="barPlace() === 'top'"
        [class.py-1]="barPlace() !== 'bottom'"
        [class.border-t]="barPlace() === 'bottom'"
        [class.justify-between]="barPlace() === 'bottom'"
        [class.border-l]="barPlace() === 'side'"
        [class.flex-col]="barPlace() === 'side'"
        [class.overflow-y-auto]="barPlace() === 'side'"
        role="toolbar"
        [attr.aria-label]="c.TOOLBAR_LABEL"
        [attr.aria-orientation]="barPlace() === 'side' ? 'vertical' : null"
        (keydown)="onToolbarKey($event)"
      >
        @for (t of tools(); track t.id; let i = $index) {
          @if (t.sep && barPlace() === 'top') {
            <span class="sdv-sep h-7 w-px shrink-0" aria-hidden="true"></span>
          }
          <button
            type="button"
            class="sdv-btn inline-flex h-11 min-w-11 shrink-0 items-center justify-center gap-1.5 rounded-field font-sans text-caption font-medium tabular-nums"
            [class.w-11]="!t.text"
            [class.px-2.5]="!!t.text"
            [attr.data-tool]="t.id"
            [attr.tabindex]="i === rovingIndex() ? 0 : -1"
            [attr.aria-label]="t.label"
            [attr.aria-disabled]="t.disabled || null"
            [attr.aria-pressed]="t.pressed === undefined ? null : t.pressed"
            [attr.aria-haspopup]="t.popup ?? null"
            [attr.aria-expanded]="t.popup ? panel() === popupFor(t.id) : null"
            (focus)="activeToolId.set(t.id)"
            (click)="useTool(t, $event)"
          >
            @if (t.icon) {
              <sd-icon [name]="t.icon" [size]="18" />
            }
            @if (t.text) {
              <span aria-hidden="true">{{ t.text }}</span>
            }
            @if (t.id === 'zoom') {
              <sd-icon name="chevron-down" [size]="14" />
            }
          </button>
        }
        @if (panel(); as p) {
          <div
            tabindex="-1"
            class="sdv-panel sdv-c sdv-l absolute z-20 overflow-auto rounded-xl border p-1.5 shadow-overlay"
            [style.left.px]="panelPos().left"
            [style.top.px]="panelPos().top"
            [style.bottom.px]="panelPos().bottom"
            [style.right.px]="panelPos().right"
            [attr.role]="p === 'zoom' || p === 'more' ? 'menu' : 'dialog'"
            [attr.aria-label]="panelLabel()"
            (keydown)="onPanelKey($event)"
          >
            @switch (p) {
              @case ('zoom') {
                @for (m of zoomItems(); track m.id) {
                  <button type="button" class="sdv-item flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 text-left font-sans text-body-sm" role="menuitemradio" tabindex="-1" [attr.aria-checked]="!!m.checked" [attr.data-item]="m.id" (click)="chooseZoom(m.id)">{{ m.label }}</button>
                }
              }
              @case ('more') {
                @for (m of moreItems(); track m.id) {
                  <button type="button" class="sdv-item flex min-h-11 w-full items-center gap-2.5 rounded-lg px-3 text-left font-sans text-body-sm" role="menuitem" tabindex="-1" [attr.data-item]="m.id" (click)="chooseMore(m.id)">
                    @if (m.icon) {
                      <sd-icon [name]="m.icon" [size]="16" />
                    }
                    {{ m.label }}
                  </button>
                }
              }
              @case ('page') {
                <div class="p-2"><ng-container [ngTemplateOutlet]="goToTpl" /></div>
              }
              @case ('keys') {
                <div class="flex flex-col gap-2 p-2 font-sans text-caption">
                  <table class="sdv-keys w-full border-collapse">
                    <tbody>
                      @for (r of shortcutRows; track r.keys) {
                        <tr>
                          <td class="font-mono whitespace-nowrap">{{ r.keys }}</td>
                          <td>{{ r.action }}</td>
                        </tr>
                      }
                    </tbody>
                  </table>
                  <div class="flex items-center gap-3 pt-2">
                    <button type="button" class="sdv-switch relative inline-flex h-6 w-11 shrink-0 items-center rounded-full" role="switch" [attr.aria-checked]="keysOn()" [attr.aria-label]="c.SINGLE_KEYS" (click)="toggleKeys()">
                      <span class="sdv-c inline-block size-5 rounded-full shadow transition-transform motion-reduce:transition-none" [class]="keysOn() ? 'translate-x-[22px]' : 'translate-x-0.5'"></span>
                    </button>
                    <span class="font-semibold">{{ c.SINGLE_KEYS }}</span>
                  </div>
                  <p class="sdv-muted">{{ c.SINGLE_KEYS_HINT }}</p>
                </div>
              }
            }
          </div>
        }
      </div>
    </ng-template>

    <ng-template #goToTpl>
      <form class="flex flex-wrap items-center gap-2" (submit)="submitPage($event)">
        <label class="font-sans text-caption font-semibold" [attr.for]="fieldId">{{ c.PAGE_NUMBER }}</label>
        <input
          class="sdv-field h-11 w-24 rounded-field px-2.5 font-sans text-body-sm"
          [id]="fieldId"
          name="page"
          inputmode="numeric"
          autocomplete="off"
          [value]="pageInput()"
          [attr.aria-invalid]="pageInputError() ? 'true' : null"
          [attr.aria-describedby]="pageInputError() ? fieldId + '-err' : null"
          (input)="pageInput.set($any($event.target).value)"
        />
        <button type="submit" class="sdv-btn sdv-p inline-flex h-11 items-center justify-center rounded-field px-4 font-sans text-body-sm font-semibold">{{ c.GO }}</button>
        @if (pageInputError()) {
          <p [id]="fieldId + '-err'" class="w-full font-sans text-caption" role="alert">{{ pageInputError() }}</p>
        }
      </form>
    </ng-template>
  `,
})
export class DocumentViewerComponent {
  private readonly zone = inject(NgZone);
  private readonly injector = inject(Injector);
  private readonly doc = inject(DOCUMENT);
  private readonly dialogs = inject(DialogService);
  private readonly loadPdf = inject(PDF_LOADER);
  private readonly textLayer = inject(TEXT_LAYER_RENDERER);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** The document. */
  readonly source = input.required<ViewerSource>();
  /** `modal` inside the outlet; `embedded` inside a host's own dialog (no header). */
  readonly mode = input<'modal' | 'embedded'>('embedded');
  readonly tone = input<ViewerTone>('light');
  /** Who is viewing, for `view_only`'s watermark (refused without it). */
  readonly watermark = input<ViewerWatermark | null>(null);
  /** A live call: Print asks first; Reload is hidden (§1.6). */
  readonly liveCall = input(false);
  /** A call is registered: the page rail starts closed and is not remembered (§1.5.3). */
  readonly inCall = input(false);
  /** Set by the outlet from the call context and the policy (§3.6). */
  readonly shareGuard = input<'none' | 'warn' | 'cover'>('none');
  /** The cloud recording runs (banner copy). */
  readonly recording = input(false);
  /** Print once the document is ready (the patient's prescription Print). */
  readonly autoPrint = input(false);
  /** The document is no longer shared: drop its bytes and show this. */
  readonly revokedText = input<string | null>(null);
  /** Page, zoom and rotation to restore (same key reopened). */
  readonly resume = input<ViewerResumeState | null>(null);
  readonly canPrevDoc = input(false);
  readonly canNextDoc = input(false);
  /** Reached by document navigation: `load()` waits 400 ms for it to settle (§1.7). */
  readonly navigated = input(false);

  /** Page, zoom and rotation (for resume). */
  readonly state = output<ViewerState>();
  readonly prevDoc = output<void>();
  readonly nextDoc = output<void>();
  /** Where the stage scroller sits inside this host (px), for the outlet's PiP. */
  readonly stageInsets = output<ViewerInsets>();
  /** "Stop sharing" on the screen-share banner or cover. */
  readonly stopSharing = output<void>();

  /** The copy the template reads, by name: a namespace object as a value (`c = copy`) adds esbuild's export helper to every app's initial bundle. */
  protected readonly c = {
    GO: copy.GO,
    HIDE_PAGES: copy.HIDE_PAGES,
    OPENING: copy.OPENING,
    PAGES: copy.PAGES,
    PAGE_NUMBER: copy.PAGE_NUMBER,
    SHARE_COVER_TITLE: copy.SHARE_COVER_TITLE,
    SHOW_ANYWAY: copy.SHOW_ANYWAY,
    SINGLE_KEYS: copy.SINGLE_KEYS,
    SINGLE_KEYS_HINT: copy.SINGLE_KEYS_HINT,
    STOP_SHARING: copy.STOP_SHARING,
    TOOLBAR_LABEL: copy.TOOLBAR_LABEL,
    pageOf: copy.pageOf,
    shareCoverText: copy.shareCoverText,
  } as const;
  protected readonly fieldId = `sd-viewer-page-${++nextSeq}`;
  protected readonly shortcutRows = copy.shortcutRows(/Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '') ? '⌘' : 'Ctrl');

  private readonly theme = pageTheme();
  protected readonly layout = viewerLayout();
  protected readonly tokens = computed(() => viewerTokens(resolveTone(this.tone(), this.theme())));

  private readonly rootEl = viewChild<ElementRef<HTMLElement>>('root');
  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  private readonly column = viewChild<ElementRef<HTMLElement>>('column');
  private readonly imageCanvas = viewChild<ElementRef<HTMLCanvasElement>>('imageCanvas');
  private readonly videoEl = viewChild<ElementRef<HTMLVideoElement>>('video');

  // ----- load state -----
  protected readonly policy = computed<ViewerPolicy>(() => {
    const id = this.source().policy;
    // An unknown id is refused anyway (§1.16); the strictest policy until then.
    return isViewerPolicyId(id) ? VIEWER_POLICIES[id] : VIEWER_POLICIES.view_only;
  });
  private readonly phase = signal<'refused' | 'revoked' | 'loading' | 'ready' | 'error'>('loading');
  protected readonly file = signal<ViewerFile | null>(null);
  private readonly errorView = signal<ViewerErrorView | null>(null);
  private readonly renderProblem = signal<'password' | 'cant_show' | 'video_error' | null>(null);
  protected readonly kind = computed<ViewerKind>(() => {
    const f = this.file();
    return f ? viewerKind(f.mime, this.policy().id) : 'none';
  });
  protected readonly shown = computed<Shown>(() => {
    switch (this.phase()) {
      case 'refused':
        return 'refused';
      case 'revoked':
        return 'revoked';
      case 'loading':
        return 'loading';
      case 'error': {
        const s = this.errorView()?.state;
        return s === 'gone' || s === 'reload' || s === 'not_viewable' ? s : 'error';
      }
    }
    if (this.source().viewable === false) return 'not_viewable';
    const problem = this.renderProblem();
    if (problem) return problem;
    const k = this.kind();
    return k === 'none' ? 'not_viewable' : k;
  });
  protected readonly extLabel = computed(() => (this.source().extension ?? '').replace(/^\.+/, '').toUpperCase());
  protected readonly imageHint = computed(() => /^(jpe?g|png|webp|heic|gif)$/i.test(this.source().extension ?? ''));
  protected readonly rendering = signal(false);

  // ----- pages, zoom, rotation -----
  protected readonly pageCount = signal(0);
  protected readonly currentPage = signal(1);
  protected readonly pageNumbers = computed(() => Array.from({ length: this.pageCount() }, (_, i) => i + 1));
  protected readonly pdfDoc = signal<PdfDocumentLike | null>(null);
  protected readonly zoomMode = signal<ZoomMode>('auto');
  private readonly customZoom = signal(1);
  protected readonly rotation = signal<0 | 90 | 180 | 270>(0);
  private readonly stageW = signal(0);
  private readonly stageH = signal(0);
  /** Page sizes at 100 % in CSS px with the page's own rotation (not the viewer's). */
  private readonly dims = new Map<number, { w: number; h: number }>();
  private readonly dimsTick = signal(0);
  private readonly imageNatural = signal<{ w: number; h: number } | null>(null);
  protected readonly scanned = signal<ReadonlySet<number>>(new Set());
  protected readonly padding = computed(() => stagePadding(this.layout() === 'phone' ? 320 : 1024));

  protected readonly zoom = computed(() => {
    const kind = this.kind();
    const shown = this.shown();
    if (shown !== 'pdf' && shown !== 'image') return 1;
    const page = kind === 'image' ? this.imageSize() : this.pageSize(1);
    const stage = { width: this.stageW() || 800, height: this.stageH() || 600 };
    return zoomFor(this.zoomMode(), this.customZoom(), kind === 'image' ? 'image' : 'pdf', stage, page, this.padding());
  });
  protected readonly cssScale = computed(() => this.zoom() * PDF_TO_CSS);
  protected readonly firstAspect = computed(() => {
    const s = this.pageSize(1);
    return s.width > 0 ? s.height / s.width : Math.SQRT2;
  });
  protected readonly imageCss = computed(() => {
    const s = this.imageSize();
    const z = this.zoom();
    return { width: Math.max(1, Math.round(s.width * z)), height: Math.max(1, Math.round(s.height * z)) };
  });

  // ----- chrome state -----
  protected readonly printBusy = signal(false);
  protected readonly printError = signal('');
  protected readonly downloadError = signal('');
  protected readonly downloadBusy = signal(false);
  protected readonly announcement = signal('');
  protected readonly railOpen = signal(false);
  protected readonly sheetOpen = signal(false);
  protected readonly panel = signal<Panel>(null);
  protected readonly panelPos = signal<{ left: number | null; top: number | null; bottom: number | null; right: number | null }>({
    left: 0,
    top: 0,
    bottom: null,
    right: null,
  });
  protected readonly keysOn = signal(readStore(KEYS_KEY) !== 'off');
  protected readonly revealed = signal(false);
  protected readonly fullscreen = signal(false);
  /** The toolbar's roving tab stop, by tool id (the list changes with the document and its state). */
  protected readonly activeToolId = signal<ToolId | null>(null);
  protected readonly pageInput = signal('');
  protected readonly pageInputError = signal('');
  protected readonly panning = signal(false);

  protected readonly covered = computed(() => {
    const s = this.shown();
    return this.shareGuard() === 'cover' && !this.revealed() && (s === 'pdf' || s === 'image' || s === 'video' || s === 'loading');
  });
  protected readonly bannerShown = computed(() => {
    const g = this.shareGuard();
    return g === 'warn' || (g === 'cover' && this.revealed());
  });
  protected readonly bannerText = computed(() => copy.shareBanner(this.recording()));

  private readonly wmText = computed(() => {
    const w = this.watermark();
    const f = this.file();
    if (!this.policy().watermark || !w) return '';
    return watermarkText({ viewerName: w.viewerName, timeZone: w.timeZone, viewedAt: f?.viewedAt ?? new Date().toISOString(), viewRef: f?.viewRef ?? null });
  });
  protected readonly thumbWatermark = computed(() => (this.policy().watermark ? this.wmText() || null : null));
  /** A watermarked policy draws nothing (pages, photo, thumbnails) without its watermark text (§1.16, D4). */
  private readonly mayDraw = computed(() => !this.policy().watermark || !!this.wmText());
  protected readonly thumbPdf = computed(() => (this.mayDraw() ? this.pdfDoc() : null));
  protected readonly overlay = computed(() => overlayLines(this.wmText()));

  protected readonly barPlace = computed<'top' | 'bottom' | 'side'>(() => {
    if (this.mode() === 'embedded') return 'top';
    const l = this.layout();
    return l === 'phone' ? 'bottom' : l === 'compact' ? 'side' : 'top';
  });
  protected readonly railPlace = computed<'side' | 'overlay' | 'sheet'>(() => {
    const l = this.layout();
    if (l === 'phone' || l === 'compact') return 'sheet';
    if (this.mode() === 'embedded' || l === 'tablet') return 'overlay';
    return 'side';
  });
  protected readonly multiPage = computed(() => this.shown() === 'pdf' && this.pageCount() >= 2);
  protected readonly railShown = computed(() => this.multiPage() && this.railOpen() && this.railPlace() !== 'sheet');
  protected readonly toolbarShown = computed(() => {
    const s = this.shown();
    return s === 'loading' || s === 'pdf' || s === 'image' || s === 'video';
  });
  protected readonly pannable = computed(() => this.shown() === 'image');

  private readonly printable = computed(() => {
    const s = this.shown();
    return (s === 'pdf' || s === 'image') && !this.covered();
  });
  /** Download applies: the policy allows it, with bytes or a link (or a fetch for not-viewable files). */
  protected readonly canDownload = computed(() => {
    if (!this.policy().download) return false;
    if (this.phase() === 'refused' || this.phase() === 'revoked') return false;
    return !!this.source().download || !!this.file() || this.shown() === 'not_viewable';
  });
  private readonly fullscreenAvailable = computed(() => {
    if (this.layout() === 'phone' || this.layout() === 'compact') return false;
    const d = this.doc as Document & { webkitFullscreenEnabled?: boolean };
    return !!(d.fullscreenEnabled || d.webkitFullscreenEnabled);
  });

  protected readonly tools = computed<readonly Tool[]>(() => {
    const shown = this.shown();
    const loading = shown === 'loading';
    const visual = shown === 'pdf' || shown === 'image';
    const isVideo = shown === 'video';
    const multi = this.multiPage();
    const place = this.barPlace();
    const z = this.zoom();
    const page = this.currentPage();
    const total = this.pageCount();
    const out: Tool[] = [];
    const compactBar = place !== 'top';
    if (multi || (loading && !this.imageHint())) {
      const open = this.railPlace() === 'sheet' ? this.sheetOpen() : this.railOpen();
      out.push({
        id: 'pages',
        label: open ? copy.HIDE_PAGES : copy.SHOW_PAGES,
        icon: open ? 'panel-left-close' : 'panel-left',
        text: this.layout() === 'desktop' && place === 'top' ? copy.PAGES : undefined,
        pressed: open,
        disabled: loading,
      });
    }
    if (visual || loading) {
      out.push({ id: 'zoomOut', label: copy.ZOOM_OUT, icon: 'zoom-out', disabled: loading || z <= 0.2501, sep: out.length > 0 });
      out.push({ id: 'zoom', label: copy.zoomLevel(zoomPercent(z)), text: `${zoomPercent(z)}%`, disabled: loading, popup: 'menu' });
      out.push({ id: 'zoomIn', label: copy.ZOOM_IN, icon: 'zoom-in', disabled: loading || z >= 3.999 });
      if (!compactBar) out.push({ id: 'rotate', label: copy.ROTATE, icon: 'rotate-cw', disabled: loading });
    }
    if (multi) {
      if (!compactBar) out.push({ id: 'prevPage', label: copy.PREVIOUS_PAGE, icon: 'chevron-up', disabled: page <= 1, sep: true });
      out.push({
        id: 'page',
        label: copy.pageButtonLabel(page, total),
        text: compactBar ? `${page}/${total}` : copy.pageOf(page, total),
        disabled: false,
        popup: compactBar ? undefined : 'dialog',
      });
      if (!compactBar) out.push({ id: 'nextPage', label: copy.NEXT_PAGE, icon: 'chevron-down', disabled: page >= total });
    }
    if (!compactBar) {
      let first = true;
      if ((visual || loading) && !isVideo) {
        out.push({ id: 'print', label: copy.PRINT, icon: 'printer', disabled: loading || this.printBusy() || this.covered(), sep: first });
        first = false;
      }
      if (this.policy().download && (this.canDownload() || loading)) {
        out.push({ id: 'download', label: copy.downloadLabel(this.source().title), icon: 'download', disabled: loading || this.downloadBusy(), sep: first });
        first = false;
      }
      if (this.fullscreenAvailable()) {
        const on = this.fullscreen();
        out.push({ id: 'fullscreen', label: on ? copy.EXIT_FULL_SCREEN : copy.FULL_SCREEN, icon: on ? 'minimize' : 'maximize', pressed: on, disabled: false, sep: first });
        first = false;
      }
      out.push({ id: 'keys', label: copy.KEYBOARD_SHORTCUTS, icon: 'keyboard', disabled: false, popup: 'dialog', sep: first });
    } else if (this.moreItems().length) {
      out.push({ id: 'more', label: copy.MORE_OPTIONS, icon: 'ellipsis', disabled: false, popup: 'menu' });
    }
    return out;
  });
  /** The one toolbar button with tabindex 0: the active tool while it exists, else the first (§1.4, WCAG 2.1.1). */
  protected readonly rovingIndex = computed(() => {
    const id = this.activeToolId();
    return Math.max(0, this.tools().findIndex((t) => t.id === id));
  });

  protected readonly zoomItems = computed<readonly MenuItem[]>(() => {
    const mode = this.zoomMode();
    const z = this.zoom();
    return [
      { id: 'width', label: copy.FIT_WIDTH, checked: mode === 'width' },
      { id: 'page', label: copy.FIT_PAGE, checked: mode === 'page' },
      ...MENU_ZOOMS.map((v) => ({ id: String(v), label: `${zoomPercent(v)}%`, checked: (mode === 'custom' || mode === 'auto') && Math.abs(z - v) < 0.005 })),
    ];
  });
  protected readonly moreItems = computed<readonly MenuItem[]>(() => {
    const shown = this.shown();
    const visual = shown === 'pdf' || shown === 'image';
    const items: MenuItem[] = [];
    if (visual) {
      items.push({ id: 'width', label: copy.FIT_WIDTH, icon: 'move-horizontal' });
      items.push({ id: 'page', label: copy.FIT_PAGE, icon: 'scan' });
      items.push({ id: 'rotate', label: copy.ROTATE, icon: 'rotate-cw' });
      if (!this.covered()) items.push({ id: 'print', label: copy.PRINT, icon: 'printer' });
    }
    if (this.canDownload()) items.push({ id: 'download', label: copy.downloadLabel(this.source().title), icon: 'download' });
    items.push({ id: 'keys', label: copy.KEYBOARD_SHORTCUTS, icon: 'keyboard' });
    return items;
  });
  protected readonly panelLabel = computed(() => {
    switch (this.panel()) {
      case 'zoom':
        return copy.zoomLevel(zoomPercent(this.zoom()));
      case 'more':
        return copy.MORE_OPTIONS;
      case 'page':
        return copy.GO_TO_PAGE;
      default:
        return copy.KEYBOARD_SHORTCUTS;
    }
  });

  // ----- cards -----
  protected readonly cardText = computed(() => {
    const p = this.policy();
    switch (this.shown()) {
      case 'refused':
        return copy.REFUSED_TEXT;
      case 'revoked':
        return this.revokedText() || copy.GONE_TEXT;
      case 'password':
        return p.id === 'view_only' ? copy.PASSWORD_VIEW_ONLY : copy.PASSWORD_OTHER;
      case 'cant_show':
        return copy.CANT_SHOW_TEXT;
      case 'video_error':
        return p.id === 'owner' || p.id === 'authored' ? copy.VIDEO_CANT_PLAY : copy.notViewableCopy(p.notViewable, this.extLabel());
      case 'not_viewable':
        return copy.notViewableCopy(p.notViewable, this.extLabel());
      case 'reload':
        return this.liveCall() ? copy.UPDATE_IN_CALL : this.errorView()?.text || copy.UPDATE_RELOAD;
      default:
        return this.errorView()?.text || copy.GENERIC_ERROR;
    }
  });
  protected readonly cardRole = computed(() => {
    const s = this.shown();
    return s === 'error' || s === 'gone' || s === 'revoked' || s === 'refused' ? 'alert' : null;
  });
  protected readonly cardAction = computed<{ id: 'retry' | 'reload' | 'download'; label: string } | null>(() => {
    const s = this.shown();
    if (s === 'error' && this.errorView()?.retry) return { id: 'retry', label: copy.TRY_AGAIN };
    if (s === 'reload') return this.liveCall() ? null : { id: 'reload', label: copy.RELOAD };
    if ((s === 'not_viewable' || s === 'video_error' || s === 'password' || s === 'cant_show') && this.canDownload()) {
      return { id: 'download', label: s === 'not_viewable' || s === 'video_error' ? copy.downloadExt(this.extLabel()) : copy.downloadExt('') };
    }
    return null;
  });

  // ----- rendering state (outside change detection) -----
  private task: PdfLoadingTaskLike | null = null;
  private pdf: PdfDocumentLike | null = null;
  private readonly pages = new Map<number, PdfPageLike>();
  private readonly renderTasks = new Map<number, PdfRenderTaskLike>();
  /** Page → the "zoom|rotation" it was drawn at. */
  private readonly drawn = new Map<number, string>();
  private readonly textJobs = new Map<number, { rotation: number; job: TextLayerJob }>();
  private readonly visibleArea = new Map<number, number>();
  private bitmap: ImageBitmap | null = null;
  private video: MediaUrl | null = null;
  private io: IntersectionObserver | null = null;
  private ro: ResizeObserver | null = null;
  private generation = 0;
  private prepared: PreparedPrint | null = null;
  private recordSub: Subscription | null = null;
  private downloadSub: Subscription | null = null;
  private asking = false;
  private autoPrinted = false;
  private resumeApplied = false;
  private lastAnnouncedPage = 1;
  private scrollTimer: ReturnType<typeof setTimeout> | undefined;
  private gestureTimer: ReturnType<typeof setTimeout> | undefined;
  private gestureScale = 1;
  private gesturePoint: Point = { x: 0, y: 0 };
  private readonly pinch = new PinchTracker();
  private panFrom: Point | null = null;
  private lastInsets = '';
  private readonly loads = new Subject<{ source: ViewerSource; delay: number } | null>();
  private keyTarget: HTMLElement | null = null;
  private readonly keyListener = (e: KeyboardEvent) => this.zone.run(() => this.onKey(e));

  constructor() {
    const destroyRef = inject(DestroyRef);
    // The colour tokens on the host (not a [style] map binding: see applyViewerTokens).
    effect(() => applyViewerTokens(this.host.nativeElement, this.tokens()));
    // One load at a time; moving on cancels (unsubscribes) the one in flight.
    const sub = this.loads
      .pipe(
        switchMap((req) => {
          if (!req) return EMPTY;
          const wait = req.delay > 0 ? after(req.delay) : of(0);
          return wait.pipe(
            switchMap(() =>
              req.source.load().pipe(
                take(1),
                map((file) => ({ req, file, err: null as unknown })),
                catchError((err: unknown) => of({ req, file: null as ViewerFile | null, err })),
              ),
            ),
          );
        }),
      )
      .subscribe(({ req, file, err }) => {
        if (req.source !== this.source()) return;
        if (file) this.loaded(file);
        else this.failed(req.source, err);
      });

    // A new source: drop the old bytes at once, then (maybe after the debounce) load.
    effect(() => {
      const src = this.source();
      untracked(() => this.start(src, this.navigated() ? NAV_DEBOUNCE_MS : 0));
    });
    // Revoked: the bytes go first, then the message shows in place.
    effect(() => {
      const text = this.revokedText();
      if (text) untracked(() => this.revoke());
    });
    // The watermark changed under the same source (an embedded host cleared it, or another
    // open() without one): checked again, so a view_only page is never drawn without it (§1.16).
    effect(() => {
      const w = this.watermark();
      untracked(() => this.recheck(w));
    });
    // Zoom or rotation changed: draw again (the text layer follows --scale-factor).
    effect(() => {
      this.zoom();
      this.rotation();
      untracked(() => this.redraw());
    });
    // Sharing stopped (or another document): the reveal is forgotten.
    effect(() => {
      if (this.shareGuard() === 'none') untracked(() => this.revealed.set(false));
    });
    // Page, zoom and rotation for resume.
    effect(() => {
      const shown = this.shown();
      if (shown !== 'pdf' && shown !== 'image') return;
      const st: ViewerState = {
        page: this.currentPage(),
        total: this.pageCount() || 1,
        zoomMode: this.zoomMode(),
        zoom: this.zoom(),
        rotation: this.rotation(),
      };
      untracked(() => this.state.emit(st));
    });

    afterNextRender(() => {
      this.observeSize();
      this.attachKeys();
      this.attachGestures();
    });
    ACTIVE.push(this);
    destroyRef.onDestroy(() => {
      sub.unsubscribe();
      const i = ACTIVE.lastIndexOf(this);
      if (i >= 0) ACTIVE.splice(i, 1);
      this.keyTarget?.removeEventListener('keydown', this.keyListener);
      this.dispose();
    });
  }

  // =============================================================== loading

  private start(src: ViewerSource, delay: number): void {
    this.release();
    this.phase.set('loading');
    this.file.set(null);
    this.errorView.set(null);
    this.renderProblem.set(null);
    this.printError.set('');
    this.downloadError.set('');
    this.revealed.set(false);
    this.zoomMode.set('auto');
    this.customZoom.set(1);
    this.rotation.set(0);
    this.currentPage.set(1);
    this.lastAnnouncedPage = 1;
    this.panel.set(null);
    this.sheetOpen.set(false);
    // The roving tab stop stays on a focused tool (']' pressed from it), else goes back to the first.
    this.activeToolId.set(this.focusedTool());
    this.autoPrinted = false;
    this.resumeApplied = false;
    if (this.revokedText()) {
      this.phase.set('revoked');
      this.loads.next(null);
      return;
    }
    const problem = sourceProblem(src, { watermark: this.watermark() ?? undefined });
    if (problem) {
      this.refuse(src, problem);
      return;
    }
    if (src.viewable === false) {
      this.phase.set('ready');
      this.loads.next(null);
      return;
    }
    this.loads.next({ source: src, delay });
  }

  /** The same source under a new watermark: refuse it when it no longer passes; load it when it now does. */
  private recheck(w: ViewerWatermark | null): void {
    const src = this.source();
    const phase = this.phase();
    if (phase === 'revoked') return;
    const problem = sourceProblem(src, { watermark: w ?? undefined });
    if (problem && phase !== 'refused') this.refuse(src, problem);
    else if (!problem && phase === 'refused') this.start(src, 0);
  }

  private focusedTool(): ToolId | null {
    const active = this.doc.activeElement;
    if (!(active instanceof HTMLElement) || !this.host.nativeElement.contains(active)) return null;
    return (active.dataset['tool'] as ToolId | undefined) ?? null;
  }

  private refuse(src: ViewerSource, reason: string): void {
    this.release();
    this.loads.next(null);
    this.file.set(null);
    this.phase.set('refused');
    console.error('[sd-viewer] refused source', src.key, reason);
  }

  /** "Try again". */
  protected retry(): void {
    this.start(this.source(), 0);
  }

  private loaded(file: ViewerFile): void {
    this.file.set(file);
    this.phase.set('ready');
    const gen = ++this.generation;
    const kind = this.kind();
    if (this.source().viewable === false || kind === 'none') return;
    if (kind === 'pdf') void this.openPdf(file.blob, gen);
    else if (kind === 'image') void this.openImage(file.blob, gen);
    else if (kind === 'video') this.openVideo(file.blob, gen);
  }

  private failed(src: ViewerSource, err: unknown): void {
    const view = src.mapError?.(err) ?? defaultErrorView(err);
    this.errorView.set(view);
    this.phase.set('error');
    if (view.state === 'gone') src.onGone?.();
  }

  private revoke(): void {
    this.release();
    this.loads.next(null);
    this.file.set(null);
    this.phase.set('revoked');
  }

  // =============================================================== PDF

  private async openPdf(blob: Blob, gen: number): Promise<void> {
    this.rendering.set(true);
    try {
      const bytes = new Uint8Array(await readBytes(blob));
      const task = await this.loadPdf(bytes);
      if (gen !== this.generation) {
        void Promise.resolve(task.destroy()).catch(() => undefined);
        return;
      }
      this.task = task;
      const pdf = await task.promise;
      if (gen !== this.generation) return;
      this.pdf = pdf;
      const first = await pdf.getPage(1);
      if (gen !== this.generation) return;
      this.pages.set(1, first);
      this.storeDims(1, first);
      this.pdfDoc.set(pdf);
      this.pageCount.set(pdf.numPages);
      this.currentPage.set(1);
      this.initRail(pdf.numPages);
      this.applyResume();
      afterNextRender(() => this.observePages(gen), { injector: this.injector });
    } catch (err: unknown) {
      if (gen !== this.generation) return;
      this.renderProblem.set(isPasswordError(err) ? 'password' : 'cant_show');
    } finally {
      if (gen === this.generation) this.rendering.set(false);
    }
  }

  private storeDims(n: number, page: PdfPageLike): void {
    const vp = page.getViewport({ scale: 1 });
    const prev = this.dims.get(n);
    const next = { w: vp.width * PDF_TO_CSS, h: vp.height * PDF_TO_CSS };
    if (!prev || prev.w !== next.w || prev.h !== next.h) {
      this.dims.set(n, next);
      this.dimsTick.update((t) => t + 1);
    }
  }

  /** Page n at 100 % with the viewer's rotation (CSS px). */
  private pageSize(n: number): { width: number; height: number } {
    this.dimsTick();
    const d = this.dims.get(n) ?? this.dims.get(1) ?? { w: 612 * PDF_TO_CSS, h: 792 * PDF_TO_CSS };
    return rotatedSize(d.w, d.h, this.rotation());
  }

  private imageSize(): { width: number; height: number } {
    const n = this.imageNatural() ?? { w: 800, h: 600 };
    return rotatedSize(n.w, n.h, this.rotation());
  }

  protected holderWidth(n: number): number {
    return Math.max(1, Math.round(this.pageSize(n).width * this.zoom()));
  }
  protected holderHeight(n: number): number {
    return Math.max(1, Math.round(this.pageSize(n).height * this.zoom()));
  }

  protected canvasRole(n: number): 'img' | null {
    if (!this.policy().textLayer) return 'img';
    return this.scanned().has(n) ? 'img' : null;
  }
  protected canvasLabel(n: number): string | null {
    const base = `${copy.pageOf(n, this.pageCount())}, ${this.source().title}`;
    if (!this.policy().textLayer) return base;
    return this.scanned().has(n) ? `${base}, scanned image without text` : null;
  }

  private holder(n: number): HTMLElement | null {
    return this.scroller()?.nativeElement.querySelector<HTMLElement>(`[data-page="${n}"]`) ?? null;
  }

  /** Watch which pages are near the screen; render those, release far ones; the current page has the largest visible area. */
  private observePages(gen: number): void {
    if (gen !== this.generation) return;
    const root = this.scroller()?.nativeElement;
    if (!root) return;
    this.io?.disconnect();
    const holders = Array.from(root.querySelectorAll<HTMLElement>('[data-page]'));
    if (typeof IntersectionObserver === 'undefined') {
      for (const h of holders) this.visibleArea.set(Number(h.dataset['page']), 1);
      for (const h of holders) void this.renderPage(Number(h.dataset['page']), gen);
      return;
    }
    this.zone.runOutsideAngular(() => {
      this.io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            const page = Number((e.target as HTMLElement).dataset['page']);
            if (e.isIntersecting) {
              const r = e.intersectionRect;
              this.visibleArea.set(page, Math.max(1, r.width * r.height));
            } else this.visibleArea.delete(page);
          }
          const near = [...this.visibleArea.keys()].sort((a, b) => a - b);
          for (const p of near) void this.renderPage(p, gen);
          this.releaseFar(near);
          this.updateCurrent();
        },
        { root, rootMargin: '400px 0px', threshold: [0, 0.25, 0.5, 0.75, 1] },
      );
      for (const h of holders) this.io.observe(h);
    });
  }

  private updateCurrent(): void {
    let best = 0;
    let page = this.currentPage();
    const root = this.scroller()?.nativeElement;
    const view = root?.getBoundingClientRect();
    for (const [n] of this.visibleArea) {
      const h = this.holder(n);
      if (!h || !view) continue;
      const r = h.getBoundingClientRect();
      const area = Math.max(0, Math.min(r.bottom, view.bottom) - Math.max(r.top, view.top)) * Math.max(0, Math.min(r.right, view.right) - Math.max(r.left, view.left));
      if (area > best) {
        best = area;
        page = n;
      }
    }
    if (best > 0 && page !== this.currentPage()) this.zone.run(() => this.currentPage.set(page));
  }

  private async renderPage(n: number, gen: number): Promise<void> {
    const pdf = this.pdf;
    const zoom = this.zoom();
    const rot = this.rotation();
    const key = `${zoom}|${rot}`;
    if (!pdf || gen !== this.generation || this.drawn.get(n) === key || this.renderTasks.has(n) || !this.mayDraw()) return;
    const canvas = this.holder(n)?.querySelector('canvas');
    if (!canvas) return;
    try {
      const page = this.pages.get(n) ?? (await pdf.getPage(n));
      this.pages.set(n, page);
      if (gen !== this.generation) return;
      this.storeDims(n, page);
      const rotation = ((page.rotate ?? 0) + rot) % 360;
      const css = zoom * PDF_TO_CSS;
      const size = page.getViewport({ scale: 1, rotation });
      const dpr = Math.max(1, globalThis.devicePixelRatio || 1);
      const viewport = page.getViewport({ scale: renderScale(css, dpr, size.width, size.height, MAX_CANVAS_AREA), rotation });
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const task = this.zone.runOutsideAngular(() => page.render({ canvas, viewport }));
      this.renderTasks.set(n, task);
      await task.promise;
      this.renderTasks.delete(n);
      if (gen !== this.generation) return;
      const cssWidth = size.width * css;
      if (this.policy().watermark) {
        const ctx = canvas.getContext('2d');
        if (ctx) drawWatermark(ctx, canvas.width, canvas.height, { text: this.wmText(), cssWidth, dpr: canvas.width / Math.max(1, cssWidth) });
      }
      this.drawn.set(n, key);
      if (this.policy().textLayer) this.ensureTextLayer(n, page, rotation, css, gen);
      if (n === 1) this.maybeAutoPrint();
    } catch {
      this.renderTasks.delete(n);
      // A cancelled render (zoom, close) is not an error; a real failure shows once.
      if (gen === this.generation && !this.drawn.size && n === 1) this.renderProblem.set('cant_show');
    }
  }

  /** The text layer for a drawn page (kept when its canvas is released; rebuilt on rotation). */
  private ensureTextLayer(n: number, page: PdfPageLike, rotation: number, css: number, gen: number): void {
    const existing = this.textJobs.get(n);
    if (existing && existing.rotation === rotation) return;
    existing?.job.cancel();
    const container = this.holder(n)?.querySelector<HTMLElement>('.sd-text-layer');
    if (!container) return;
    container.replaceChildren();
    container.removeAttribute('data-main-rotation');
    container.removeAttribute('style');
    const viewport = page.getViewport({ scale: css, rotation });
    const job = this.zone.runOutsideAngular(() => this.textLayer({ page, container, viewport }));
    this.textJobs.set(n, { rotation, job });
    job.promise.then(
      () => {
        if (gen !== this.generation) return;
        const empty = !(container.textContent ?? '').trim();
        const has = this.scanned().has(n);
        if (empty !== has) {
          this.zone.run(() =>
            this.scanned.update((s) => {
              const next = new Set(s);
              if (empty) next.add(n);
              else next.delete(n);
              return next;
            }),
          );
        }
      },
      () => undefined,
    );
  }

  /** Pages more than three away from those on screen: free their canvases (the text layer stays). */
  private releaseFar(near: number[]): void {
    if (!near.length) return;
    const lo = near[0] - KEEP_AROUND;
    const hi = near[near.length - 1] + KEEP_AROUND;
    for (const n of [...this.drawn.keys()]) {
      if (n >= lo && n <= hi) continue;
      this.drawn.delete(n);
      if (n !== 1) {
        this.pages.get(n)?.cleanup();
        this.pages.delete(n);
      }
      const c = this.holder(n)?.querySelector('canvas');
      if (c) c.width = c.height = 0;
    }
  }

  private redraw(): void {
    const gen = this.generation;
    if (this.pdf) {
      for (const t of this.renderTasks.values()) {
        try {
          t.cancel();
        } catch {
          /* done */
        }
      }
      this.renderTasks.clear();
      // Drawn at another size: draw the visible ones again once the holders have their new size.
      afterNextRender(
        () => {
          for (const p of [...this.visibleArea.keys()]) void this.renderPage(p, gen);
        },
        { injector: this.injector },
      );
    }
    if (this.bitmap) afterNextRender(() => this.drawImage(), { injector: this.injector });
  }

  // =============================================================== images and video

  private async openImage(blob: Blob, gen: number): Promise<void> {
    this.rendering.set(true);
    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      if (gen !== this.generation) {
        bitmap.close?.();
        return;
      }
      this.bitmap = bitmap;
      this.imageNatural.set({ w: bitmap.width, h: bitmap.height });
      this.applyResume();
      afterNextRender(() => this.drawImage(), { injector: this.injector });
    } catch {
      if (gen === this.generation) this.renderProblem.set('cant_show');
    } finally {
      if (gen === this.generation) this.rendering.set(false);
    }
  }

  private drawImage(): void {
    const bmp = this.bitmap;
    const canvas = this.imageCanvas()?.nativeElement;
    if (!bmp || !canvas || !bmp.width || !this.mayDraw()) return;
    const css = this.imageCss();
    const dpr = Math.max(1, globalThis.devicePixelRatio || 1);
    let w = css.width * dpr;
    let h = css.height * dpr;
    const cap = Math.min(1, (SCREEN_IMAGE_MAX_PX * dpr) / Math.max(w, h), Math.sqrt(MAX_CANVAS_AREA / Math.max(1, w * h)));
    w *= cap;
    h *= cap;
    canvas.width = Math.max(1, Math.floor(w));
    canvas.height = Math.max(1, Math.floor(h));
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    drawRotated(ctx, bmp, canvas.width, canvas.height, this.rotation());
    if (this.policy().watermark) drawWatermark(ctx, canvas.width, canvas.height, { text: this.wmText(), cssWidth: css.width, dpr: canvas.width / css.width });
    this.maybeAutoPrint();
  }

  private openVideo(blob: Blob, gen: number): void {
    afterNextRender(
      () => {
        if (gen !== this.generation) return;
        const video = this.videoEl()?.nativeElement;
        if (!video) return;
        this.video?.revoke();
        this.video = mediaUrl(blob);
        video.src = this.video.url;
      },
      { injector: this.injector },
    );
  }

  protected onVideoError(): void {
    if (this.shown() === 'video') this.renderProblem.set('video_error');
  }

  /** view_only video never stays in the browser's fullscreen (its watermark layer isn't there). */
  protected onFullscreenChange(): void {
    const d = this.doc as Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
    const full = d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
    const video = this.videoEl()?.nativeElement;
    if (video && full === video && !this.policy().nativeVideoFullscreen) {
      try {
        if (typeof d.exitFullscreen === 'function') void Promise.resolve(d.exitFullscreen()).catch(() => undefined);
        else d.webkitExitFullscreen?.();
      } catch {
        /* not in fullscreen after all */
      }
    }
    this.fullscreen.set(!!full && full === this.fullscreenTarget());
  }

  /** iOS: the player's own fullscreen. */
  protected onWebkitVideoFullscreen(): void {
    if (this.policy().nativeVideoFullscreen) return;
    const video = this.videoEl()?.nativeElement as (HTMLVideoElement & { webkitExitFullscreen?: () => void }) | undefined;
    try {
      video?.webkitExitFullscreen?.();
    } catch {
      /* already left */
    }
  }

  // =============================================================== zoom, rotate, pages

  protected setZoom(mode: ZoomMode, value?: number): void {
    if (mode === 'custom') this.customZoom.set(clampZoom(value ?? this.zoom()));
    this.zoomMode.set(mode);
    if (mode === 'width') this.announce(copy.FIT_WIDTH);
    else if (mode === 'page') this.announce(copy.FIT_PAGE);
    else this.announce(copy.zoomAnnounce(zoomPercent(this.zoom())));
  }

  private stepZoom(dir: 1 | -1): void {
    if (!this.visual()) return;
    this.setZoom('custom', nextZoom(this.zoom(), dir));
  }

  private rotate(dir: 1 | -1): void {
    if (!this.visual()) return;
    const page = this.currentPage();
    const next = (((this.rotation() + dir * 90) % 360) + 360) % 360;
    this.rotation.set(next as 0 | 90 | 180 | 270);
    this.announce(copy.rotatedTo(next));
    if (this.shown() === 'pdf') afterNextRender(() => this.scrollToPage(page, false), { injector: this.injector });
  }

  private visual(): boolean {
    const s = this.shown();
    return s === 'pdf' || s === 'image';
  }

  /** Jump to a page (a button, key or thumbnail): announced at once. */
  protected goTo(n: number, announce: boolean): void {
    const total = this.pageCount();
    if (!total) return;
    const page = Math.min(total, Math.max(1, Math.round(n)));
    this.currentPage.set(page);
    this.scrollToPage(page, true);
    if (announce) {
      this.lastAnnouncedPage = page;
      this.announce(copy.pageOf(page, total));
    }
  }

  private scrollToPage(n: number, smooth: boolean): void {
    const root = this.scroller()?.nativeElement;
    const h = this.holder(n);
    if (!root || !h) return;
    const behavior: ScrollBehavior = smooth && !reducedMotion(this.doc) ? 'smooth' : 'auto';
    const top = h.offsetTop - this.padding();
    if (typeof root.scrollTo === 'function') root.scrollTo({ top, behavior });
    else root.scrollTop = top;
  }

  protected submitPage(e: Event): void {
    e.preventDefault();
    const total = this.pageCount();
    const n = Number(this.pageInput().trim());
    if (!Number.isInteger(n) || n < 1 || n > total) {
      this.pageInputError.set(copy.pageRange(total));
      return;
    }
    this.pageInputError.set('');
    this.closePanel(false);
    this.sheetOpen.set(false);
    this.goTo(n, true);
    this.scroller()?.nativeElement.focus({ preventScroll: true });
  }

  private applyResume(): void {
    const r = this.resume();
    if (!r || this.resumeApplied) return;
    this.resumeApplied = true;
    this.rotation.set(r.rotation);
    this.zoomMode.set(r.zoomMode);
    if (r.zoomMode === 'custom') this.customZoom.set(clampZoom(r.zoom));
    if (this.pageCount() > 1 && r.page > 1) {
      const page = Math.min(this.pageCount(), r.page);
      this.currentPage.set(page);
      afterNextRender(() => this.scrollToPage(page, false), { injector: this.injector });
    }
    this.lastAnnouncedPage = this.currentPage();
    this.announce(copy.backOnPage(this.currentPage()));
  }

  private initRail(total: number): void {
    if (total < 2) return this.railOpen.set(false);
    if (this.inCall()) return this.railOpen.set(false);
    if (this.railPlace() !== 'side') return this.railOpen.set(false);
    const remembered = readStore(PAGES_KEY);
    this.railOpen.set(remembered ? remembered === 'open' : true);
  }

  private togglePages(): void {
    if (this.railPlace() === 'sheet') {
      if (this.sheetOpen()) this.closeSheet();
      else this.openSheet();
      return;
    }
    const open = !this.railOpen();
    this.railOpen.set(open);
    if (!this.inCall() && this.railPlace() === 'side') writeStore(PAGES_KEY, open ? 'open' : 'closed');
  }

  private openSheet(): void {
    this.pageInput.set(String(this.currentPage()));
    this.pageInputError.set('');
    this.sheetOpen.set(true);
    afterNextRender(() => this.rootEl()?.nativeElement.querySelector<HTMLInputElement>('.sdv-sheet input')?.focus(), { injector: this.injector });
  }

  protected closeSheet(): void {
    this.sheetOpen.set(false);
    this.focusTool('pages');
  }

  // =============================================================== toolbar

  protected popupFor(id: ToolId): Panel {
    return id === 'zoom' ? 'zoom' : id === 'page' ? 'page' : id === 'keys' ? 'keys' : id === 'more' ? 'more' : null;
  }

  protected useTool(t: Tool, e: Event): void {
    if (t.disabled) return;
    switch (t.id) {
      case 'pages':
        return this.togglePages();
      case 'zoomOut':
        return this.stepZoom(-1);
      case 'zoomIn':
        return this.stepZoom(1);
      case 'rotate':
        return this.rotate(1);
      case 'prevPage':
        return this.goTo(this.currentPage() - 1, true);
      case 'nextPage':
        return this.goTo(this.currentPage() + 1, true);
      case 'print':
        return void this.print();
      case 'download':
        return this.download();
      case 'fullscreen':
        return void this.toggleFullscreen();
      case 'page':
        if (this.barPlace() !== 'top') return this.openSheet();
        return this.openPanel('page', e.currentTarget as HTMLElement);
      default: {
        const p = this.popupFor(t.id);
        if (p) this.openPanel(p, e.currentTarget as HTMLElement);
      }
    }
  }

  private openPanel(p: Exclude<Panel, null>, trigger: HTMLElement): void {
    if (this.panel() === p) return this.closePanel(true);
    const bar = trigger.closest<HTMLElement>('.sdv-bar');
    const place = this.barPlace();
    if (bar) {
      const left = Math.max(4, Math.min(trigger.offsetLeft, bar.clientWidth - 220));
      if (place === 'top') this.panelPos.set({ left, top: bar.offsetHeight, bottom: null, right: null });
      else if (place === 'bottom') this.panelPos.set({ left, top: null, bottom: bar.offsetHeight, right: null });
      else this.panelPos.set({ left: null, top: Math.max(4, trigger.offsetTop), bottom: null, right: bar.offsetWidth });
    }
    if (p === 'page') {
      this.pageInput.set(String(this.currentPage()));
      this.pageInputError.set('');
    }
    this.panel.set(p);
    afterNextRender(
      () => {
        const panel = this.rootEl()?.nativeElement.querySelector<HTMLElement>('.sdv-panel');
        const first =
          panel?.querySelector<HTMLElement>('[aria-checked="true"]') ?? panel?.querySelector<HTMLElement>('input, [role^="menuitem"], button');
        first?.focus();
      },
      { injector: this.injector },
    );
  }

  private closePanel(refocus: boolean): void {
    const p = this.panel();
    if (!p) return;
    this.panel.set(null);
    if (refocus) this.focusTool(p === 'zoom' ? 'zoom' : p === 'page' ? 'page' : p === 'more' ? 'more' : this.barPlace() === 'top' ? 'keys' : 'more');
  }

  private focusTool(id: ToolId): void {
    afterNextRender(() => this.rootEl()?.nativeElement.querySelector<HTMLElement>(`[data-tool="${id}"]`)?.focus(), { injector: this.injector });
  }

  protected chooseZoom(id: string): void {
    this.closePanel(true);
    if (id === 'width' || id === 'page') this.setZoom(id);
    else this.setZoom('custom', Number(id));
  }

  protected chooseMore(id: string): void {
    this.closePanel(id !== 'keys');
    switch (id) {
      case 'width':
      case 'page':
        return this.setZoom(id);
      case 'rotate':
        return this.rotate(1);
      case 'print':
        return void this.print();
      case 'download':
        return this.download();
      case 'keys': {
        const more = this.rootEl()?.nativeElement.querySelector<HTMLElement>('[data-tool="more"]');
        if (more) this.openPanel('keys', more);
      }
    }
  }

  protected toggleKeys(): void {
    const on = !this.keysOn();
    this.keysOn.set(on);
    writeStore(KEYS_KEY, on ? 'on' : 'off');
  }

  /** Roving focus across the toolbar (Left/Right, or Up/Down when vertical; Home/End). */
  protected onToolbarKey(e: KeyboardEvent): void {
    if (inMenu(e.target)) return;
    const tools = this.tools();
    const n = tools.length;
    if (!n) return;
    const vertical = this.barPlace() === 'side';
    // From the focused tool (the list may have changed since it was focused), else the tab stop.
    const focused = e.target instanceof HTMLElement ? e.target.dataset['tool'] : undefined;
    const at = tools.findIndex((t) => t.id === focused);
    let next = at >= 0 ? at : this.rovingIndex();
    if (e.key === (vertical ? 'ArrowDown' : 'ArrowRight')) next = (next + 1) % n;
    else if (e.key === (vertical ? 'ArrowUp' : 'ArrowLeft')) next = (next - 1 + n) % n;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = n - 1;
    else return;
    e.preventDefault();
    e.stopPropagation();
    this.activeToolId.set(tools[next]?.id ?? null);
    const buttons = (e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>(':scope > button[data-tool]');
    buttons[next]?.focus();
  }

  /** Menus: Up/Down/Home/End move; Esc closes and returns focus to the button. */
  protected onPanelKey(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      this.closePanel(true);
      return;
    }
    const p = this.panel();
    if (p !== 'zoom' && p !== 'more') return;
    const items = Array.from((e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role^="menuitem"]'));
    const i = items.indexOf(e.target as HTMLElement);
    let next = i;
    if (e.key === 'ArrowDown') next = (i + 1) % items.length;
    else if (e.key === 'ArrowUp') next = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    else if (e.key === 'Tab') {
      this.closePanel(false);
      return;
    } else return;
    e.preventDefault();
    items[next]?.focus();
  }

  protected runCardAction(id: 'retry' | 'reload' | 'download'): void {
    if (id === 'retry') this.retry();
    else if (id === 'reload') this.doc.defaultView?.location.reload();
    else this.download();
  }

  protected showAnyway(): void {
    this.revealed.set(true);
    this.announce(copy.SHOWN_WHILE_SHARING);
  }

  // =============================================================== keys

  private attachKeys(): void {
    const target = this.mode() === 'modal' ? (this.host.nativeElement.closest<HTMLElement>('.sd-viewer-frame') ?? this.host.nativeElement) : this.host.nativeElement;
    this.keyTarget = target;
    this.zone.runOutsideAngular(() => target.addEventListener('keydown', this.keyListener));
  }

  /** Keys while focus is inside the viewer (the frame in modal mode, the host when embedded). */
  protected onKey(e: KeyboardEvent): void {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    const lower = key.length === 1 ? key.toLowerCase() : key;
    if (mod && !e.altKey && lower === 'p') {
      e.preventDefault();
      if (this.printable()) void this.print();
      return;
    }
    if (mod && !e.altKey && lower === 's') {
      e.preventDefault();
      if (this.canDownload()) this.download();
      return;
    }
    if (mod || e.altKey) return;
    if (key === 'Escape') {
      if (this.panel()) {
        e.preventDefault();
        e.stopPropagation();
        this.closePanel(true);
      } else if (this.sheetOpen()) {
        e.preventDefault();
        e.stopPropagation();
        this.closeSheet();
      } else if (this.railOpen() && this.railPlace() === 'overlay') {
        e.preventDefault();
        e.stopPropagation();
        this.railOpen.set(false);
        this.focusTool('pages');
      }
      return;
    }
    const field = isField(e.target);
    if (!field && (key === 'PageDown' || key === 'PageUp' || key === 'Home' || key === 'End') && this.shown() === 'pdf') {
      e.preventDefault();
      const n = key === 'PageDown' ? this.currentPage() + 1 : key === 'PageUp' ? this.currentPage() - 1 : key === 'Home' ? 1 : this.pageCount();
      this.goTo(n, true);
      return;
    }
    if (field || inMenu(e.target) || !this.keysOn() || key.length !== 1) return;
    let handled = true;
    switch (key) {
      case '+':
      case '=':
        this.stepZoom(1);
        break;
      case '-':
      case '_':
        this.stepZoom(-1);
        break;
      case '0':
        if (this.visual()) this.setZoom('width');
        break;
      case '1':
        if (this.visual()) this.setZoom('page');
        break;
      case 'r':
        this.rotate(1);
        break;
      case 'R':
        this.rotate(-1);
        break;
      case 't':
      case 'T':
        if (this.multiPage()) this.togglePages();
        break;
      case 'f':
      case 'F':
        if (this.fullscreenAvailable()) void this.toggleFullscreen();
        break;
      case '[':
        if (this.canPrevDoc()) this.prevDoc.emit();
        break;
      case ']':
        if (this.canNextDoc()) this.nextDoc.emit();
        break;
      case '?': {
        const btn = this.rootEl()?.nativeElement.querySelector<HTMLElement>('[data-tool="keys"],[data-tool="more"]');
        if (btn) this.openPanel('keys', btn);
        break;
      }
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  }

  /**
   * Ctrl/Cmd+P anywhere: only the active instance (the last mounted, still
   * connected) answers; Print when it can, else just prevented — never the
   * browser's own print of the page behind.
   */
  protected onWindowKey(e: KeyboardEvent): void {
    if (e.defaultPrevented || !(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 'p') return;
    if (activeViewer() !== this) return;
    e.preventDefault();
    if (this.printable()) void this.print();
  }

  protected deter(e: Event): void {
    if (this.policy().deterrents) e.preventDefault();
  }

  // =============================================================== gestures

  private attachGestures(): void {
    const el = this.scroller()?.nativeElement;
    if (!el) return;
    this.zone.runOutsideAngular(() => {
      el.addEventListener(
        'wheel',
        (e: WheelEvent) => {
          if (!(e.ctrlKey || e.metaKey) || !this.visual()) return;
          e.preventDefault();
          const r = el.getBoundingClientRect();
          this.gestureZoom(wheelFactor(e.deltaY, e.deltaMode), { x: e.clientX - r.left, y: e.clientY - r.top });
        },
        { passive: false },
      );
      el.addEventListener('pointerdown', (e: PointerEvent) => this.onPointerDown(e, el));
      el.addEventListener('pointermove', (e: PointerEvent) => this.onPointerMove(e, el));
      const up = (e: PointerEvent) => this.onPointerUp(e, el);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('scroll', () => this.onScroll(), { passive: true });
    });
  }

  private onPointerDown(e: PointerEvent, el: HTMLElement): void {
    if (e.pointerType === 'touch') {
      const r = el.getBoundingClientRect();
      this.pinch.down(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top });
      return;
    }
    if (e.pointerType !== 'mouse' || e.button !== 0 || this.shown() !== 'image') return;
    if (el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight) return;
    this.panFrom = { x: e.clientX, y: e.clientY };
    el.setPointerCapture?.(e.pointerId);
    this.zone.run(() => this.panning.set(true));
  }

  private onPointerMove(e: PointerEvent, el: HTMLElement): void {
    if (e.pointerType === 'touch') {
      const r = el.getBoundingClientRect();
      const before = this.gestureScale;
      const res = this.pinch.move(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top });
      if (res && this.visual()) this.gestureZoom(res.scale / before, res.center, true);
      return;
    }
    if (!this.panFrom) return;
    el.scrollLeft -= e.clientX - this.panFrom.x;
    el.scrollTop -= e.clientY - this.panFrom.y;
    this.panFrom = { x: e.clientX, y: e.clientY };
  }

  private onPointerUp(e: PointerEvent, el: HTMLElement): void {
    if (e.pointerType === 'touch') {
      this.pinch.up(e.pointerId);
      return;
    }
    if (!this.panFrom) return;
    this.panFrom = null;
    el.releasePointerCapture?.(e.pointerId);
    this.zone.run(() => this.panning.set(false));
  }

  /**
   * Pinch / Ctrl+wheel: the page column scales at once (CSS transform around
   * the point), and is redrawn sharp 150 ms after the gesture stops, with the
   * scroll corrected so the point stays put.
   */
  private gestureZoom(factor: number, point: Point, absolute = false): void {
    const base = this.zoom();
    const target = clampZoom(base * (absolute ? factor * this.gestureScale : this.gestureScale * factor));
    this.gestureScale = target / base;
    this.gesturePoint = point;
    const el = this.scroller()?.nativeElement;
    const col = (this.column()?.nativeElement ?? this.imageCanvas()?.nativeElement.parentElement) as HTMLElement | undefined;
    if (col && el) {
      col.style.transformOrigin = `${point.x + el.scrollLeft}px ${point.y + el.scrollTop}px`;
      col.style.transform = `scale(${this.gestureScale})`;
    }
    clearTimeout(this.gestureTimer);
    this.gestureTimer = setTimeout(() => this.zone.run(() => this.commitGesture()), GESTURE_SETTLE_MS);
  }

  private commitGesture(): void {
    const ratio = this.gestureScale;
    this.gestureScale = 1;
    // Fingers still down: later moves scale from here, not from where the pinch began.
    this.pinch.rebase();
    const el = this.scroller()?.nativeElement;
    const col = (this.column()?.nativeElement ?? this.imageCanvas()?.nativeElement.parentElement) as HTMLElement | undefined;
    if (col) {
      col.style.transform = '';
      col.style.transformOrigin = '';
    }
    if (Math.abs(ratio - 1) < 0.001) return;
    const before = { left: el?.scrollLeft ?? 0, top: el?.scrollTop ?? 0 };
    const point = this.gesturePoint;
    const old = this.zoom();
    this.setZoom('custom', old * ratio);
    const applied = this.zoom() / old;
    afterNextRender(
      () => {
        if (!el) return;
        const next = scrollAfterZoom(before.left, before.top, point, applied);
        el.scrollLeft = next.left;
        el.scrollTop = next.top;
      },
      { injector: this.injector },
    );
  }

  /** Double-click / double-tap: the default fit ↔ 200 % at the point. */
  protected onDoubleClick(e: MouseEvent): void {
    if (!this.visual() || (e.target as HTMLElement | null)?.closest('.sd-text-layer span')) return;
    const el = this.scroller()?.nativeElement;
    const r = el?.getBoundingClientRect();
    const point = { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
    const old = this.zoom();
    const before = { left: el?.scrollLeft ?? 0, top: el?.scrollTop ?? 0 };
    if (this.zoomMode() === 'custom' && Math.abs(old - 2) < 0.01) this.setZoom('auto');
    else this.setZoom('custom', 2);
    const ratio = this.zoom() / old;
    afterNextRender(
      () => {
        if (!el) return;
        const next = scrollAfterZoom(before.left, before.top, point, ratio);
        el.scrollLeft = next.left;
        el.scrollTop = next.top;
      },
      { injector: this.injector },
    );
  }

  private onScroll(): void {
    clearTimeout(this.scrollTimer);
    this.scrollTimer = setTimeout(() => {
      const page = this.currentPage();
      if (this.shown() === 'pdf' && page !== this.lastAnnouncedPage) {
        this.lastAnnouncedPage = page;
        this.zone.run(() => this.announce(copy.pageOf(page, this.pageCount())));
      }
    }, SCROLL_ANNOUNCE_MS);
  }

  // =============================================================== size

  private observeSize(): void {
    const el = this.scroller()?.nativeElement;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (w && w !== this.stageW()) this.zone.run(() => this.stageW.set(w));
      if (h && h !== this.stageH()) this.zone.run(() => this.stageH.set(h));
      this.emitInsets(el);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    this.zone.runOutsideAngular(() => {
      let frame = 0;
      this.ro = new ResizeObserver(() => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(measure);
      });
      this.ro.observe(el);
      this.ro.observe(this.host.nativeElement);
    });
  }

  private emitInsets(el: HTMLElement): void {
    const host = this.host.nativeElement.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const insets: ViewerInsets = {
      top: Math.round(r.top - host.top),
      left: Math.round(r.left - host.left),
      right: Math.round(host.right - r.right),
      bottom: Math.round(host.bottom - r.bottom),
    };
    const key = `${insets.top},${insets.right},${insets.bottom},${insets.left}`;
    if (key === this.lastInsets) return;
    this.lastInsets = key;
    this.zone.run(() => this.stageInsets.emit(insets));
  }

  // =============================================================== full screen

  private fullscreenTarget(): HTMLElement {
    const host = this.host.nativeElement;
    return this.mode() === 'modal' ? (host.closest<HTMLElement>('.sd-viewer-frame') ?? host) : host;
  }

  private async toggleFullscreen(): Promise<void> {
    const d = this.doc as Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
    if (d.fullscreenElement ?? d.webkitFullscreenElement) {
      await this.exitFullscreen();
      return;
    }
    const target = this.fullscreenTarget() as HTMLElement & { webkitRequestFullscreen?: () => void };
    try {
      if (typeof target.requestFullscreen === 'function') await target.requestFullscreen();
      else target.webkitRequestFullscreen?.();
    } catch {
      /* refused (no user gesture, policy) */
    }
  }

  private async exitFullscreen(): Promise<void> {
    const d = this.doc as Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
    try {
      if (d.fullscreenElement && typeof d.exitFullscreen === 'function') await d.exitFullscreen();
      else if (d.webkitFullscreenElement) d.webkitExitFullscreen?.();
    } catch {
      /* not in full screen */
    }
  }

  // =============================================================== print

  private maybeAutoPrint(): void {
    if (!this.autoPrint() || this.autoPrinted) return;
    this.autoPrinted = true;
    this.zone.run(() => void this.print());
  }

  /** Print (D5): view_only records first and prints only on success; every other policy prints at once. */
  async print(): Promise<void> {
    if (this.printBusy() || this.asking || !this.printable()) return;
    const src = this.source();
    const file = this.file();
    const gen = this.generation;
    const problem = sourceProblem(src, { watermark: this.watermark() ?? undefined });
    if (problem) {
      this.refuse(src, problem);
      return;
    }
    this.printError.set('');
    await this.exitFullscreen();
    if (this.liveCall()) {
      this.asking = true;
      let confirmed = false;
      try {
        ({ confirmed } = await this.dialogs.confirm({ tone: 'info', icon: 'printer', ...copy.PRINT_CONFIRM }));
      } finally {
        this.asking = false;
      }
      if (!confirmed || gen !== this.generation) return;
    }
    this.printBusy.set(true);
    this.announce(copy.PREPARING_PRINT);
    let prepared: PreparedPrint;
    try {
      const pages = await this.zone.runOutsideAngular(() => this.renderPrintPages());
      if (gen !== this.generation) {
        this.printBusy.set(false);
        return;
      }
      prepared = await buildPrintRoot(pages);
    } catch (err: unknown) {
      this.printBusy.set(false);
      if (gen === this.generation) this.printError.set(err instanceof PrintTooLongError ? PRINT_TOO_LONG : PRINT_FAILED);
      return;
    }
    if (gen !== this.generation) {
      prepared.cleanup();
      this.printBusy.set(false);
      return;
    }
    this.prepared?.cleanup();
    this.prepared = prepared;
    if (this.policy().print === 'audited' && file && src.recordPrint) {
      this.recordSub?.unsubscribe();
      this.recordSub = src
        .recordPrint(file)
        .pipe(take(1), defaultIfEmpty(null))
        .subscribe({
          next: () => this.finishPrint(gen),
          error: () => {
            this.recordSub = null;
            this.prepared?.cleanup();
            this.prepared = null;
            this.printBusy.set(false);
            this.printError.set(PRINT_FAILED);
          },
        });
      return;
    }
    this.finishPrint(gen);
  }

  private finishPrint(gen: number): void {
    this.recordSub = null;
    const p = this.prepared;
    this.prepared = null;
    this.printBusy.set(false);
    if (!p) return;
    if (gen !== this.generation) {
      p.cleanup();
      return;
    }
    void this.exitFullscreen().then(() => p.print());
  }

  /** Each page as a JPEG: view_only at 150 DPI, watermarked, with the footer; else 200 DPI, plain. As rotated on screen. */
  private async renderPrintPages(): Promise<Blob[]> {
    const p = this.policy();
    const file = this.file();
    const wm = this.watermark();
    const watermark = p.watermark ? this.wmText() : null;
    if (p.watermark && !watermark) throw new Error('no watermark');
    const footer =
      p.printFooter && wm
        ? printFooterText({ viewerName: wm.viewerName, timeZone: wm.timeZone, viewRef: file?.viewRef ?? null, printedAt: new Date().toISOString() })
        : null;
    const rot = this.rotation();
    const out: Blob[] = [];
    if (this.pdf) {
      const pdf = this.pdf;
      if (pdf.numPages > MAX_PRINT_PAGES) throw new PrintTooLongError();
      const scale = p.printDpi / 72;
      const dpr = p.printDpi / 96;
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = this.pages.get(n) ?? (await pdf.getPage(n));
        const vp = page.getViewport({ scale, rotation: ((page.rotate ?? 0) + rot) % 360 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(vp.width);
        canvas.height = Math.floor(vp.height);
        await page.render({ canvas, viewport: vp }).promise;
        out.push(await composePrintPage(canvas, canvas.width, canvas.height, { dpr, watermark, footer }));
        canvas.width = canvas.height = 0;
        if (!this.pages.has(n)) page.cleanup();
      }
      return out;
    }
    const bmp = this.bitmap;
    if (!bmp) throw new Error('nothing to print');
    const nat = rotatedSize(bmp.width, bmp.height, rot);
    // Natural size, at most 3000 px on the long side; a small photo is drawn up to the printed width.
    const k = Math.min(PRINT_IMAGE_MAX_PX / Math.max(nat.width, nat.height), Math.max(1, PRINT_PAGE_CSS_PX / nat.width));
    const w = Math.max(1, Math.floor(nat.width * k));
    const h = Math.max(1, Math.floor(nat.height * k));
    let source: CanvasImageSource = bmp;
    let scratch: HTMLCanvasElement | null = null;
    if (rot) {
      scratch = document.createElement('canvas');
      scratch.width = w;
      scratch.height = h;
      const ctx = scratch.getContext('2d');
      if (ctx) drawRotated(ctx, bmp, w, h, rot);
      source = scratch;
    }
    try {
      out.push(await composePrintPage(source, w, h, { dpr: w / PRINT_PAGE_CSS_PX, watermark, footer }));
    } finally {
      if (scratch) scratch.width = scratch.height = 0;
    }
    return out;
  }

  // =============================================================== download

  /** Download (§1.8.2): the source's signed link, or the viewed bytes (fetched first for a not-viewable file). */
  download(): void {
    if (!this.canDownload() || this.downloadBusy()) return;
    const src = this.source();
    this.downloadError.set('');
    const name = src.filename ?? safeFilename(src.title, src.extension);
    const done = (blob: Blob, filename: string) => {
      saveBlob(blob, filename, this.doc);
      this.announce(copy.DOWNLOAD_STARTED);
    };
    const file = this.file();
    if (!src.download && file) {
      try {
        done(file.blob, name);
      } catch {
        this.downloadError.set(copy.DOWNLOAD_FAILED);
      }
      return;
    }
    const bytes$ = src.download ? src.download() : src.load().pipe(map((f) => ({ blob: f.blob, filename: name })));
    this.downloadBusy.set(true);
    this.downloadSub?.unsubscribe();
    this.downloadSub = bytes$.pipe(take(1)).subscribe({
      next: ({ blob, filename }) => {
        this.downloadBusy.set(false);
        try {
          done(blob, filename);
        } catch {
          this.downloadError.set(copy.DOWNLOAD_FAILED);
        }
      },
      error: () => {
        this.downloadBusy.set(false);
        this.downloadError.set(copy.DOWNLOAD_FAILED);
      },
    });
  }

  // =============================================================== misc

  private announce(text: string): void {
    this.announcement.set(this.announcement() === text ? `${text}\u00a0` : text);
  }

  /** Drop the current file's rendering: tasks, canvases, URLs, the bitmap, a pending print. */
  private release(): void {
    this.generation++;
    this.io?.disconnect();
    this.io = null;
    for (const t of this.renderTasks.values()) {
      try {
        t.cancel();
      } catch {
        /* already done */
      }
    }
    this.renderTasks.clear();
    for (const t of this.textJobs.values()) t.job.cancel();
    this.textJobs.clear();
    for (const p of this.pages.values()) {
      try {
        p.cleanup();
      } catch {
        /* already released */
      }
    }
    this.pages.clear();
    this.drawn.clear();
    this.visibleArea.clear();
    this.dims.clear();
    this.dimsTick.update((t) => t + 1);
    const root = this.rootEl()?.nativeElement;
    root?.querySelectorAll('canvas').forEach((c) => (c.width = c.height = 0));
    root?.querySelectorAll('.sd-text-layer').forEach((t) => t.replaceChildren());
    if (this.task) void Promise.resolve(this.task.destroy()).catch(() => undefined);
    this.task = null;
    this.pdf = null;
    this.pdfDoc.set(null);
    this.bitmap?.close?.();
    this.bitmap = null;
    this.imageNatural.set(null);
    const video = this.videoEl()?.nativeElement;
    if (video) {
      video.pause?.();
      video.removeAttribute('src');
    }
    this.video?.revoke();
    this.video = null;
    this.recordSub?.unsubscribe();
    this.recordSub = null;
    this.downloadSub?.unsubscribe();
    this.downloadSub = null;
    this.downloadBusy.set(false);
    this.prepared?.cleanup();
    this.prepared = null;
    this.printBusy.set(false);
    this.pageCount.set(0);
    this.scanned.set(new Set());
    clearTimeout(this.gestureTimer);
    this.gestureScale = 1;
    this.pinch.reset();
  }

  private dispose(): void {
    this.release();
    this.loads.next(null);
    this.ro?.disconnect();
    this.ro = null;
    clearTimeout(this.scrollTimer);
  }
}

/** The instance that answers window-level Ctrl/Cmd+P. */
function activeViewer(): DocumentViewerComponent | null {
  for (let i = ACTIVE.length - 1; i >= 0; i--) {
    const v = ACTIVE[i] as unknown as { host: ElementRef<HTMLElement> };
    if (v.host.nativeElement.isConnected) return ACTIVE[i];
  }
  return null;
}

/** Draw a bitmap into a w × h canvas turned clockwise by `rotation` degrees. */
function drawRotated(ctx: CanvasRenderingContext2D, bmp: CanvasImageSource & { width: number; height: number }, w: number, h: number, rotation: number): void {
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  const sideways = rotation % 180 !== 0;
  const dw = sideways ? h : w;
  const dh = sideways ? w : h;
  ctx.drawImage(bmp, -dw / 2, -dh / 2, dw, dh);
  ctx.restore();
}
