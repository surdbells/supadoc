import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { SESSION_AUTH, SESSION_TIMEOUT_CONFIG, type SessionAuth } from '@supadoc/auth';
import { App } from './app';

/** Signed-out stand-in for the auth silo the idle-timeout dialog watches. */
const sessionAuthStub: SessionAuth = {
  isAuthenticated: signal(false),
  expire: () => undefined,
  logout: () => undefined,
  keepAlive: () => Promise.resolve(),
  sessionDeadline: () => null,
  rememberRedirect: () => undefined,
  activityKey: 'test.activity',
};

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter([]),
        { provide: SESSION_AUTH, useValue: sessionAuthStub },
        {
          provide: SESSION_TIMEOUT_CONFIG,
          useValue: {
            idleMinutes: 15,
            warningSeconds: 60,
            keepAliveMinutes: 4,
            loginUrl: '/auth/login',
          },
        },
      ],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance).toBeTruthy();
  });
});
