import { HttpBackend, HttpXhrBackend } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { appConfig } from './app.config';

describe('appConfig', () => {
  it('sends requests through XHR, the only backend that reports upload progress', () => {
    // Angular's default (fetch) never emits UploadProgress: upload bars sat at 0% until the response.
    TestBed.configureTestingModule({ providers: appConfig.providers });
    expect(TestBed.inject(HttpBackend)).toBeInstanceOf(HttpXhrBackend);
  });
});
