import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createMockTelemetry } from './fixtures/factories.js';
import { TelemetryAnchorStatus } from '../src/shared/types/telemetry.js';

const paymentFindMock = jest.fn();
const ledgerUpdateOneMock = jest.fn();
const telemetryFindMock = jest.fn();
const telemetryUpdateOneMock = jest.fn();

await jest.unstable_mockModule('../src/modules/payments/payments.model.js', () => ({
  PaymentModel: {
    find: paymentFindMock,
  },
}));

await jest.unstable_mockModule('../src/modules/ledger/ledger.model.js', () => ({
  LedgerBlock: {
    updateOne: ledgerUpdateOneMock,
  },
}));

await jest.unstable_mockModule('../src/modules/telemetry/telemetry.model.js', () => ({
  Telemetry: {
    find: telemetryFindMock,
    updateOne: telemetryUpdateOneMock,
  },
  TelemetryModel: {
    find: telemetryFindMock,
    updateOne: telemetryUpdateOneMock,
  },
  TelemetryAnchorStatus: {
    PENDING_ANCHOR: 'PENDING_ANCHOR',
    ANCHORED: 'ANCHORED',
    ANCHOR_FAILED: 'ANCHOR_FAILED',
    VERIFIED: 'VERIFIED',
  },
}));

const { indexStellarTransactions } = await import('../src/workers/stellar-indexer.worker.js');

describe('stellar indexer worker', () => {
  beforeEach(() => {
    paymentFindMock.mockReset();
    ledgerUpdateOneMock.mockReset();
    telemetryFindMock.mockReset();
    telemetryUpdateOneMock.mockReset();

    paymentFindMock.mockReturnValue({
      select: () => ({
        lean: async () => [],
      }),
    });
    telemetryFindMock.mockReturnValue({
      select: () => ({
        lean: async () => [],
      }),
    });
  });

  it('creates/upserts a ledger block from mocked Stellar transaction data', async () => {
    paymentFindMock.mockReturnValue({
      select: () => ({
        lean: async () => [{ shipmentId: '507f1f77bcf86cd799439011', stellarTxHash: 'tx-1' }],
      }),
    });

    ledgerUpdateOneMock.mockResolvedValue({ upsertedCount: 1 });

    const client = {
      getLatestLedger: async () => 105,
      getTransaction: async () => ({ hash: 'tx-1', ledger: 100, memo: 'SETTLEMENT_COMPLETED' }),
    };

    const result = await indexStellarTransactions(client);

    expect(result.processed).toBe(1);
    expect(result.upserted).toBe(1);
    expect(result.verified).toBe(1);
    expect(ledgerUpdateOneMock).toHaveBeenCalledTimes(1);
  });

  it('handles duplicate transaction hashes idempotently', async () => {
    paymentFindMock.mockReturnValue({
      select: () => ({
        lean: async () => [
          { shipmentId: '507f1f77bcf86cd799439011', stellarTxHash: 'tx-dup' },
          { shipmentId: '507f1f77bcf86cd799439012', stellarTxHash: 'tx-dup' },
        ],
      }),
    });

    ledgerUpdateOneMock.mockResolvedValue({ upsertedCount: 1 });

    const client = {
      getLatestLedger: async () => 101,
      getTransaction: async () => ({ hash: 'tx-dup', ledger: 100, memo: 'SETTLEMENT_COMPLETED' }),
    };

    const result = await indexStellarTransactions(client);

    expect(result.processed).toBe(1);
    expect(ledgerUpdateOneMock).toHaveBeenCalledTimes(1);
  });

  it('throws when chain query fails so BullMQ can retry with backoff', async () => {
    paymentFindMock.mockReturnValue({
      select: () => ({
        lean: async () => [{ shipmentId: '507f1f77bcf86cd799439011', stellarTxHash: 'tx-fail' }],
      }),
    });

    const client = {
      getLatestLedger: async () => 100,
      getTransaction: async () => {
        throw new Error('horizon unavailable');
      },
    };

    await expect(indexStellarTransactions(client)).rejects.toThrow('horizon unavailable');
  });

  it('covers telemetry anchor verification path with confirmation metadata and verified flip', async () => {
    const telemetryFixture = createMockTelemetry({
      shipmentId: '507f1f77bcf86cd799439011',
      stellarTxHash: 'tx-telemetry-1',
      anchorStatus: TelemetryAnchorStatus.ANCHORED,
      verified: false,
    });

    telemetryFindMock.mockReturnValue({
      select: () => ({
        lean: async () => [telemetryFixture],
      }),
    });

    telemetryUpdateOneMock.mockResolvedValue({ modifiedCount: 1 });
    ledgerUpdateOneMock.mockResolvedValue({ upsertedCount: 1 });

    const client = {
      getLatestLedger: async () => 105,
      getTransaction: async () => ({
        hash: 'tx-telemetry-1',
        ledger: 100,
        memo: 'TELEMETRY_ANCHOR',
      }),
    };

    const result = await indexStellarTransactions(client);

    expect(result.processed).toBe(1);
    expect(result.upserted).toBe(1);
    expect(result.verified).toBe(1);

    expect(telemetryUpdateOneMock).toHaveBeenCalledWith(
      { _id: telemetryFixture._id },
      {
        $set: {
          verified: true,
          confirmationMetadata: {
            blockNumber: 100,
            ledger: 100,
            confirmations: 5,
            verified: true,
            memo: 'TELEMETRY_ANCHOR',
            indexedAt: expect.any(String),
          },
          metadata: {
            blockNumber: 100,
            ledger: 100,
            confirmations: 5,
            verified: true,
            memo: 'TELEMETRY_ANCHOR',
            indexedAt: expect.any(String),
          },
        },
      }
    );

    expect(ledgerUpdateOneMock).toHaveBeenCalledWith(
      { transactionHash: 'tx-telemetry-1' },
      expect.objectContaining({
        $setOnInsert: {
          shipmentId: '507f1f77bcf86cd799439011',
          eventType: 'IN_TRANSIT',
          transactionHash: 'tx-telemetry-1',
          actor: 'stellar-indexer',
        },
        $set: expect.objectContaining({
          metadata: expect.objectContaining({
            blockNumber: 100,
            ledger: 100,
            confirmations: 5,
            verified: true,
          }),
        }),
      }),
      { upsert: true }
    );
  });

  it('does not flip verified when confirmations are below minimum threshold', async () => {
    const telemetryFixture = createMockTelemetry({
      shipmentId: '507f1f77bcf86cd799439011',
      stellarTxHash: 'tx-telemetry-pending',
      anchorStatus: TelemetryAnchorStatus.ANCHORED,
      verified: false,
    });

    telemetryFindMock.mockReturnValue({
      select: () => ({
        lean: async () => [telemetryFixture],
      }),
    });

    telemetryUpdateOneMock.mockResolvedValue({ modifiedCount: 1 });
    ledgerUpdateOneMock.mockResolvedValue({ upsertedCount: 1 });

    const client = {
      getLatestLedger: async () => 101,
      getTransaction: async () => ({
        hash: 'tx-telemetry-pending',
        ledger: 100,
        memo: 'TELEMETRY_ANCHOR',
      }),
    };

    const result = await indexStellarTransactions(client, 3);

    expect(result.processed).toBe(1);
    expect(result.verified).toBe(0);

    expect(telemetryUpdateOneMock).toHaveBeenCalledWith(
      { _id: telemetryFixture._id },
      {
        $set: {
          verified: false,
          confirmationMetadata: {
            blockNumber: 100,
            ledger: 100,
            confirmations: 1,
            verified: false,
            memo: 'TELEMETRY_ANCHOR',
            indexedAt: expect.any(String),
          },
          metadata: {
            blockNumber: 100,
            ledger: 100,
            confirmations: 1,
            verified: false,
            memo: 'TELEMETRY_ANCHOR',
            indexedAt: expect.any(String),
          },
        },
      }
    );
  });
});
