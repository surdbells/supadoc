import { XhrFactory } from '@angular/common';
import {
  HttpBackend,
  HttpEventType,
  HttpXhrBackend,
  provideHttpClient,
  withInterceptors,
  withXhr,
  type HttpEvent,
} from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import type { ApiError } from '@supadoc/models';
import { firstValueFrom, toArray } from 'rxjs';
import { API_CONFIG } from './api-config';
import { NETWORK_ERROR_MESSAGE, SERVER_ERROR_MESSAGE } from './api-error.util';
import { ApiService } from './api.service';
import { parseDocumentView } from './document-view';
import { DocumentsApi } from './documents.api';
import { httpErrorInterceptor } from './http-error.interceptor';
import { LOGGER } from './logger';
import { uploadProgressFrom } from './upload-progress';

type Listener = (event: unknown) => void;

class FakeTarget {
  private readonly listeners = new Map<string, Set<Listener>>();
  addEventListener(type: string, fn: Listener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(fn);
  }
  removeEventListener(type: string, fn: Listener): void {
    this.listeners.get(type)?.delete(fn);
  }
  fire(type: string, event: unknown = {}): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
  }
}

/** Just enough XMLHttpRequest for Angular's HttpXhrBackend, driven by the test. */
class FakeXhr extends FakeTarget {
  readonly DONE = 4;
  readonly upload = new FakeTarget();
  readonly sentHeaders: Record<string, string> = {};
  method = '';
  url = '';
  body: unknown = undefined;
  responseType: XMLHttpRequestResponseType = '';
  readyState = 0;
  status = 0;
  statusText = '';
  response: unknown = undefined;
  responseText = '';
  responseURL = '';
  aborted = false;
  private headerBlock = '';

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
    this.readyState = 1;
  }
  setRequestHeader(name: string, value: string): void {
    this.sentHeaders[name.toLowerCase()] = value;
  }
  send(body: unknown): void {
    this.body = body;
  }
  abort(): void {
    this.aborted = true;
  }
  getAllResponseHeaders(): string {
    return this.headerBlock;
  }

  // ----- what the browser would do -----
  progress(loaded: number, total?: number): void {
    this.upload.fire('progress', { loaded, total: total ?? 0, lengthComputable: total !== undefined });
  }
  respond(status: number, body: string | Blob, headers: Record<string, string> = {}): void {
    this.status = status;
    this.statusText = status < 400 ? 'OK' : 'Error';
    this.responseURL = this.url;
    this.headerBlock = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n');
    this.readyState = 4;
    if (this.responseType === 'blob') {
      this.response = body instanceof Blob ? body : new Blob([body]);
    } else {
      this.response = body;
      this.responseText = typeof body === 'string' ? body : '';
    }
    this.fire('load');
  }
  fail(): void {
    this.readyState = 4;
    this.fire('error', new ProgressEvent('error'));
  }
}

const BASE = 'http://api.test';

/**
 * The web apps send HttpClient requests through XHR (`withXhr()`), the only
 * Angular backend that reports upload progress. These run the real backend
 * against a scripted XMLHttpRequest, with the shared error interceptor, to
 * prove the things the apps rely on behave as they did over fetch.
 */
describe('HttpClient over XHR (withXhr)', () => {
  let xhrs: FakeXhr[];
  const last = () => xhrs[xhrs.length - 1];

  beforeEach(() => {
    xhrs = [];
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([httpErrorInterceptor]), withXhr()),
        {
          provide: XhrFactory,
          useValue: {
            build: () => {
              const xhr = new FakeXhr();
              xhrs.push(xhr);
              return xhr as unknown as XMLHttpRequest;
            },
          },
        },
        { provide: LOGGER, useValue: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } },
        { provide: API_CONFIG, useValue: { baseUrl: BASE } },
      ],
    });
  });

  it('uses the XHR backend', () => {
    expect(TestBed.inject(HttpBackend)).toBeInstanceOf(HttpXhrBackend);
  });

  it('reports upload progress for a multipart upload, then the stored document', async () => {
    const events: HttpEvent<unknown>[] = [];
    const done = firstValueFrom(
      TestBed.inject(DocumentsApi).upload(new File(['%PDF-1.4'], 'scan.pdf', { type: 'application/pdf' }), 'lab').pipe(toArray()),
    ).then((all) => events.push(...all));
    const xhr = last();
    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe(`${BASE}/api/portal/documents`);
    expect(xhr.body).toBeInstanceOf(FormData);
    // The browser writes the multipart boundary itself.
    expect(xhr.sentHeaders['content-type']).toBeUndefined();
    xhr.progress(250, 1000);
    xhr.progress(1000, 1000);
    xhr.respond(201, JSON.stringify({ status: 'success', message: 'Uploaded', data: { id: 'd-1' } }), {
      'Content-Type': 'application/json',
    });
    await done;
    expect(events.map((e) => e.type)).toEqual([
      HttpEventType.Sent,
      HttpEventType.UploadProgress,
      HttpEventType.UploadProgress,
      HttpEventType.Response,
    ]);
    expect(events.map(uploadProgressFrom).filter(Boolean)).toEqual([
      { percent: 25, finishing: false },
      { percent: 100, finishing: true },
    ]);
    const res = events[3] as { body: { data: { id: string } } };
    expect(res.body.data.id).toBe('d-1');
  });

  it('a size the browser cannot tell comes through with no total', async () => {
    const events: HttpEvent<unknown>[] = [];
    const done = firstValueFrom(
      TestBed.inject(DocumentsApi).upload(new File(['x'], 'a.pdf'), 'lab').pipe(toArray()),
    ).then((all) => events.push(...all));
    last().progress(512);
    last().respond(201, JSON.stringify({ status: 'success', message: 'OK', data: { id: 'd-2' } }));
    await done;
    expect(uploadProgressFrom(events[1])).toEqual({ percent: null, finishing: false });
  });

  it('sends request headers (the passive-poll marker) and the JSON Accept', async () => {
    const got = firstValueFrom(TestBed.inject(ApiService).get('api/portal/notifications', undefined, { passive: true }));
    expect(last().sentHeaders['x-sd-passive']).toBe('1');
    expect(last().sentHeaders['accept']).toContain('application/json');
    last().respond(200, JSON.stringify({ status: 'success', data: [] }));
    await expect(got).resolves.toEqual({ status: 'success', data: [] });
  });

  it('reads response headers and the blob body (observe: response) for the view-only viewer', async () => {
    const got = firstValueFrom(TestBed.inject(ApiService).getBlobResponse('api/doctor/documents/d-1/view', undefined, { 'X-SD-Viewer': '1' }));
    const xhr = last();
    expect(xhr.responseType).toBe('blob');
    expect(xhr.sentHeaders['x-sd-viewer']).toBe('1');
    xhr.respond(200, new Blob(['%PDF'], { type: 'application/pdf' }), {
      'Content-Type': 'application/pdf',
      'X-SD-View-Ref': 'VM-0A1B2C3D',
    });
    const view = parseDocumentView(await got);
    expect(view.viewRef).toBe('VM-0A1B2C3D');
    expect(view.mime).toBe('application/pdf');
    expect(view.blob.size).toBe(4);
  });

  it('a blob download keeps its JSON error code (the interceptor parses the Blob body)', async () => {
    const got = firstValueFrom(TestBed.inject(ApiService).getBlob('api/portal/documents/d-1/file'));
    last().respond(
      403,
      new Blob([JSON.stringify({ status: 'error', message: 'This file is not shared with you.', errors: { code: 'not_shared' } })], {
        type: 'application/json',
      }),
      { 'Content-Type': 'application/json' },
    );
    const err = (await got.catch((e: unknown) => e)) as ApiError;
    expect(err.statusCode).toBe(403);
    expect(err.errors?.['code']).toBe('not_shared');
    expect(err.message).toBe('This file is not shared with you.');
  });

  it("a JSON 401's code reaches the session layer, and Retry-After is read", async () => {
    const got = firstValueFrom(TestBed.inject(ApiService).get('api/portal/me'));
    last().respond(401, JSON.stringify({ status: 'error', message: 'Token expired', errors: { code: 'token_expired' } }), {
      'Content-Type': 'application/json',
      'Retry-After': '3',
    });
    const err = (await got.catch((e: unknown) => e)) as ApiError;
    expect(err.statusCode).toBe(401);
    expect(err.errors?.['code']).toBe('token_expired');
    expect(err.retryAfterMs).toBe(3000);
  });

  it('no response at all (offline, CORS) is status 0 with the friendly message', async () => {
    const got = firstValueFrom(TestBed.inject(ApiService).get('api/portal/me'));
    last().fail();
    const err = (await got.catch((e: unknown) => e)) as ApiError;
    expect(err.statusCode).toBe(0);
    expect(err.message).toBe(NETWORK_ERROR_MESSAGE);
  });

  it('a 2xx whose body is not JSON (a PHP notice first) is a server problem, and no URL reaches the page or the log', async () => {
    const got = firstValueFrom(TestBed.inject(ApiService).get('api/public/call/secret-token'));
    last().respond(200, '<br />\n<b>Deprecated</b>: something in x.php on line 3<br />\n{"status":"success","data":{}}', {
      'Content-Type': 'application/json',
    });
    const err = (await got.catch((e: unknown) => e)) as ApiError;
    expect(err.statusCode).toBe(200);
    expect(err.message).toBe(SERVER_ERROR_MESSAGE);
    const logged = vi.mocked(TestBed.inject(LOGGER).error).mock.calls;
    expect(logged).toHaveLength(1);
    expect(JSON.stringify(logged[0])).not.toContain('secret-token');
    expect(JSON.stringify(logged[0])).not.toContain('Http failure');
  });

  it('unsubscribing (Remove / cancel) aborts the request', () => {
    const sub = TestBed.inject(DocumentsApi).upload(new File(['x'], 'a.pdf'), 'lab').subscribe();
    sub.unsubscribe();
    expect(last().aborted).toBe(true);
  });
});
