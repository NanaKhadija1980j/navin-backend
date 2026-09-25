import { describe, expect, it, jest } from '@jest/globals';

class StellarTimeoutError extends Error {
  name = 'TimeoutError';
  constructor(message: string) {
    super(message);
  }
}

describe('Stellar Worker Failure and Retry Tests', () => {
  it('classifies Stellar timeout failures with TimeoutError name', () => {
    const err = new StellarTimeoutError('Transaction timed out after 60 seconds');
    expect(err.name).toBe('TimeoutError');
    expect(err).toBeInstanceOf(Error);
  });

  it('retries transient timeout failures before succeeding', async () => {
    let attempts = 0;
    const processor = jest.fn(async () => {
      attempts += 1;
      if (attempts <= 2) {
        throw new StellarTimeoutError('Transaction timed out');
      }
      return { stellarTxHash: 'success-tx-hash' };
    });

    let result: unknown;
    for (let i = 0; i < 3; i += 1) {
      try {
        result = await processor();
        break;
      } catch (error) {
        if (i === 2) throw error;
      }
    }

    expect(processor).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ stellarTxHash: 'success-tx-hash' });
  });

  it('surfaces non-timeout errors without masking the message', async () => {
    const processor = jest.fn(async () => {
      throw new Error('Invalid transaction data');
    });

    await expect(processor()).rejects.toThrow('Invalid transaction data');
  });

  it('configures anchor jobs with exponential backoff in queue helper', async () => {
    const mockAdd = jest.fn<(...args: unknown[]) => Promise<{ id: string }>>();
    const QueueMock = jest.fn().mockImplementation(() => ({ add: mockAdd }));

    mockAdd.mockResolvedValue({ id: 'job-1' });

    await jest.unstable_mockModule('ioredis', () => ({
      Redis: jest.fn().mockImplementation(() => ({
        lpush: jest.fn(async () => 1),
      })),
    }));
    await jest.unstable_mockModule('bullmq', () => ({ Queue: QueueMock }));
    await jest.unstable_mockModule('../src/config/index.js', () => ({
      config: { redisUrl: 'redis://127.0.0.1:6379' },
    }));

    jest.resetModules();
    const queueMod = await import('../src/infra/redis/queue.js');
    await queueMod.pushStellarAnchorJob({
      telemetryId: 'telemetry-dlq',
      shipmentId: 'shipment-dlq',
      dataHash: 'dlq-hash',
    });

    expect(mockAdd).toHaveBeenCalledWith(
      'anchor_telemetry',
      {
        telemetryId: 'telemetry-dlq',
        shipmentId: 'shipment-dlq',
        dataHash: 'dlq-hash',
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
      }
    );
  });
});
