import { describe, it, expect, beforeEach, afterEach, afterAll, jest } from '@jest/globals';
import request from 'supertest';
import type { Request, Response, NextFunction } from 'express';
import { EventEmitter } from 'events';
import type { RealtimeEvent } from '../src/shared/types/realtimeEvents.js';
import { redisMock, signToken as signJwt } from './fixtures/factories.js';

// Mock lifecycle (#626): resetModules → unstable_mockModule → dynamic import.
// The in-memory Redis mock must be registered before anything imports
// tokenBlocklist, and must never be wiped by a later resetModules().
const redisStore = new Map<string, string>();
jest.resetModules();
await jest.unstable_mockModule('../src/infra/redis/connection.js', () => redisMock(redisStore));

const { buildApp } = await import('../src/app.js');
const { blockToken } = await import('../src/infra/redis/tokenBlocklist.js');
const { requireSseAuth } = await import('../src/shared/middleware/requireSseAuth.js');
const { deliverToUserForTest, getSseClientCount, registerSseClient, resetSseHubForTest } =
  await import('../src/infra/sse/sseHub.js');

const VALID_JTI = '550e8400-e29b-41d4-a716-446655440000';
const REVOKED_JTI = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';

function createMockResponse(): Response & EventEmitter {
  const emitter = new EventEmitter();
  const chunks: string[] = [];

  const res = Object.assign(emitter, {
    writableEnded: false,
    writeHead: jest.fn((_status: number, _headers: Record<string, string>) => undefined),
    write: jest.fn((chunk: string) => {
      chunks.push(chunk);
      return true;
    }),
    end: jest.fn(() => {
      (res as { writableEnded: boolean }).writableEnded = true;
    }),
    get chunks() {
      return chunks;
    },
  }) as unknown as Response & EventEmitter & { chunks: string[] };

  return res;
}

function signToken(overrides: Record<string, unknown> = {}): string {
  return signJwt(
    { userId: 'user-123', role: 'ADMIN', organizationId: 'org-456', jti: VALID_JTI, ...overrides },
    { expiresIn: '1h' }
  );
}

describe('GET /api/events — SSE endpoint', () => {
  const app = buildApp();

  beforeEach(() => {
    redisStore.clear();
    resetSseHubForTest();
  });

  afterEach(() => {
    jest.useRealTimers();
    resetSseHubForTest();
  });

  afterAll(() => {
    redisStore.clear();
    resetSseHubForTest();
  });

  describe('authentication', () => {
    it('returns 401 when no token is provided', async () => {
      const res = await request(app).get('/api/events');
      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('returns 401 for an invalid token', async () => {
      const res = await request(app)
        .get('/api/events')
        .set('Authorization', 'Bearer invalid-token');

      expect(res.status).toBe(401);
      expect(res.body.success).toBe(false);
    });

    it('returns 401 when token is revoked', async () => {
      await blockToken(REVOKED_JTI, 3600);

      const token = signToken({ jti: REVOKED_JTI });
      const res = await request(app)
        .get('/api/events')
        .set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('TOKEN_REVOKED');
    });

    it('accepts JWT via Authorization header', async () => {
      const token = signToken();
      const req = {
        headers: { authorization: `Bearer ${token}` },
        query: {},
      } as unknown as Request;

      const next = jest.fn() as jest.MockedFunction<NextFunction>;
      await requireSseAuth(req, {} as Response, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.user?.userId).toBe('user-123');
    });

    it('accepts JWT via ?token= query parameter', async () => {
      const token = signToken();
      const req = {
        headers: {},
        query: { token },
      } as unknown as Request;

      const next = jest.fn() as jest.MockedFunction<NextFunction>;
      await requireSseAuth(req, {} as Response, next);

      expect(next).toHaveBeenCalledWith();
      expect(req.user?.userId).toBe('user-123');
    });
  });

  describe('SSE stream behavior', () => {
    it('sets text/event-stream headers and sends connected comment', () => {
      const res = createMockResponse();
      registerSseClient('user-123', res);

      expect(res.writeHead).toHaveBeenCalledWith(
        200,
        expect.objectContaining({
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
        })
      );
      expect(res.chunks.join('')).toContain(': connected');
      expect(getSseClientCount('user-123')).toBe(1);
    });

    it('delivers typed events to connected clients', () => {
      const res = createMockResponse();
      registerSseClient('user-123', res);

      const event: RealtimeEvent = {
        type: 'shipment:status',
        shipmentId: 'ship-1',
        newStatus: 'IN_TRANSIT',
        timestamp: '2026-01-15T12:00:00.000Z',
      };

      deliverToUserForTest('user-123', event);

      const output = res.chunks.join('');
      expect(output).toContain('event: shipment:status');
      expect(output).toContain('"newStatus":"IN_TRANSIT"');
    });

    it('sends heartbeat comments every 30 seconds', () => {
      jest.useFakeTimers();
      const res = createMockResponse();
      registerSseClient('user-123', res);

      const initialChunks = res.chunks.length;
      jest.advanceTimersByTime(30_000);

      expect(res.chunks.length).toBeGreaterThan(initialChunks);
      expect(res.chunks.at(-1)).toBe(': heartbeat\n\n');
    });

    it('removes client on close', () => {
      const res = createMockResponse();
      registerSseClient('user-123', res);
      expect(getSseClientCount('user-123')).toBe(1);

      res.emit('close');
      expect(getSseClientCount('user-123')).toBe(0);
    });
  });
});
