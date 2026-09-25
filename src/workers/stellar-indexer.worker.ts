import '../loadEnv.js';
import { pathToFileURL } from 'node:url';
import { Worker, Queue, type Job } from 'bullmq';
import { Horizon } from '@stellar/stellar-sdk';
import { connectMongo } from '../infra/mongo/connection.js';
import { config } from '../config/index.js';
import { getBullMQConnection } from '../infra/redis/connection.js';
import { PaymentModel } from '../modules/payments/payments.model.js';
import { Telemetry } from '../modules/telemetry/telemetry.model.js';
import { LedgerBlock } from '../modules/ledger/ledger.model.js';
import { MilestoneEvent } from '../shared/types/shipment.js';
import { logger } from '../shared/logger/logger.js';

export const STELLAR_INDEXER_QUEUE = 'stellar_indexer_queue';
export const STELLAR_INDEXER_JOB = 'poll_stellar_transactions';

export interface StellarTransaction {
  hash: string;
  ledger: number;
  memo?: string;
  createdAt?: string;
}

export interface StellarIndexerClient {
  getLatestLedger: () => Promise<number>;
  getTransaction: (hash: string) => Promise<StellarTransaction | null>;
}

/**
 * Builds a Horizon-backed {@link StellarIndexerClient}. Uses the resolved Horizon
 * URL from config (derived from STELLAR_NETWORK, overridable via HORIZON_URL).
 */
export function createHorizonIndexerClient(
  horizonUrl: string = config.horizonUrl
): StellarIndexerClient {
  const server = new Horizon.Server(horizonUrl);

  return {
    async getLatestLedger(): Promise<number> {
      const page = await server.ledgers().limit(1).order('desc').call();
      const record = page.records[0];
      return record ? record.sequence : 0;
    },
    async getTransaction(hash: string): Promise<StellarTransaction | null> {
      try {
        const tx = await server.transactions().transaction(hash).call();
        return {
          hash: tx.hash,
          ledger: tx.ledger_attr,
          memo: tx.memo ?? undefined,
          createdAt: tx.created_at,
        };
      } catch {
        // Not found on the ledger yet — treated as "pending confirmation".
        return null;
      }
    },
  };
}

const DEFAULT_CONFIRMATIONS = 3;

function toMilestoneEvent(memo?: string): MilestoneEvent {
  const text = (memo ?? '').toUpperCase();

  if (text.includes('TELEMETRY')) return MilestoneEvent.IN_TRANSIT;
  if (text.includes('SETTLEMENT_INITIATED')) return MilestoneEvent.SETTLEMENT_INITIATED;
  if (text.includes('PROOF_SUBMITTED')) return MilestoneEvent.PROOF_SUBMITTED;
  if (text.includes('DELIVERED')) return MilestoneEvent.DELIVERED;
  return MilestoneEvent.SETTLEMENT_COMPLETED;
}

export async function indexStellarTransactions(
  client: StellarIndexerClient,
  minConfirmations: number = DEFAULT_CONFIRMATIONS
): Promise<{ processed: number; upserted: number; verified: number }> {
  const payments = await PaymentModel.find({ stellarTxHash: { $exists: true, $ne: null } })
    .select('_id shipmentId stellarTxHash')
    .lean();

  const telemetryRecords = await Telemetry.find({ stellarTxHash: { $exists: true, $ne: null } })
    .select('_id shipmentId stellarTxHash')
    .lean();

  const seen = new Set<string>();
  const latestLedger = await client.getLatestLedger();

  let processed = 0;
  let upserted = 0;
  let verified = 0;

  for (const payment of payments) {
    const txHash = String((payment as { stellarTxHash?: string }).stellarTxHash ?? '').trim();
    if (!txHash || seen.has(txHash)) {
      continue;
    }
    seen.add(txHash);

    const tx = await client.getTransaction(txHash);
    if (!tx) {
      continue;
    }

    processed += 1;
    const confirmations = Math.max(0, latestLedger - tx.ledger);
    const isVerified = confirmations >= minConfirmations;

    if (isVerified) {
      verified += 1;
    }

    const metadata = {
      blockNumber: tx.ledger,
      ledger: tx.ledger,
      confirmations,
      verified: isVerified,
      memo: tx.memo,
      indexedAt: new Date().toISOString(),
    };

    const result = await LedgerBlock.updateOne(
      { transactionHash: tx.hash },
      {
        $setOnInsert: {
          shipmentId: String((payment as { shipmentId: unknown }).shipmentId),
          eventType: toMilestoneEvent(tx.memo),
          transactionHash: tx.hash,
          actor: 'stellar-indexer',
        },
        $set: { metadata },
      },
      { upsert: true }
    );

    if ((result as { upsertedCount?: number }).upsertedCount) {
      upserted += 1;
    }
  }

  for (const record of telemetryRecords) {
    const txHash = String((record as { stellarTxHash?: string }).stellarTxHash ?? '').trim();
    if (!txHash || seen.has(txHash)) {
      continue;
    }
    seen.add(txHash);

    const tx = await client.getTransaction(txHash);
    if (!tx) {
      continue;
    }

    processed += 1;
    const confirmations = Math.max(0, latestLedger - tx.ledger);
    const isVerified = confirmations >= minConfirmations;

    if (isVerified) {
      verified += 1;
    }

    const metadata = {
      blockNumber: tx.ledger,
      ledger: tx.ledger,
      confirmations,
      verified: isVerified,
      memo: tx.memo,
      indexedAt: new Date().toISOString(),
    };

    await Telemetry.updateOne(
      { _id: (record as { _id: unknown })._id },
      {
        $set: {
          verified: isVerified,
          confirmationMetadata: metadata,
          metadata,
        },
      }
    );

    const eventType =
      tx.memo &&
      (tx.memo.toUpperCase().includes('SETTLEMENT') ||
        tx.memo.toUpperCase().includes('PROOF') ||
        tx.memo.toUpperCase().includes('DELIVERED'))
        ? toMilestoneEvent(tx.memo)
        : MilestoneEvent.IN_TRANSIT;

    const result = await LedgerBlock.updateOne(
      { transactionHash: tx.hash },
      {
        $setOnInsert: {
          shipmentId: String((record as { shipmentId: unknown }).shipmentId),
          eventType,
          transactionHash: tx.hash,
          actor: 'stellar-indexer',
        },
        $set: { metadata },
      },
      { upsert: true }
    );

    if ((result as { upsertedCount?: number }).upsertedCount) {
      upserted += 1;
    }
  }

  return { processed, upserted, verified };
}

async function processIndexerJob(
  _job: Job,
  client: StellarIndexerClient
): Promise<{ processed: number; upserted: number; verified: number }> {
  const summary = await indexStellarTransactions(client);
  logger.info(summary, 'Stellar indexer polling cycle complete');
  return summary;
}

export async function startStellarIndexerWorker(client: StellarIndexerClient): Promise<Worker> {
  await connectMongo(config.mongoUri);

  const queue = new Queue(STELLAR_INDEXER_QUEUE, { connection: getBullMQConnection() });
  await queue.add(
    STELLAR_INDEXER_JOB,
    {},
    {
      jobId: STELLAR_INDEXER_JOB,
      repeat: { every: 30_000 },
      attempts: 5,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    }
  );

  const worker = new Worker(STELLAR_INDEXER_QUEUE, async job => processIndexerJob(job, client), {
    connection: getBullMQConnection(),
    concurrency: 1,
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Stellar indexer job failed');
  });

  worker.on('completed', job => {
    logger.info({ jobId: job.id }, 'Stellar indexer job completed');
  });

  return worker;
}

// Self-start entrypoint. Fires only when executed as a script (node/tsx directly),
// matching the docker/CI worker-topology decision; stays inert when imported by
// the test-suite so module import has no side effects.
const isDirectRun =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  startStellarIndexerWorker(createHorizonIndexerClient()).catch(err => {
    logger.error({ err }, 'Stellar indexer worker bootstrap failed');
    process.exitCode = 1;
  });
}
