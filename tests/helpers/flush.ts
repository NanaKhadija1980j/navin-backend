/**
 * Deterministic async synchronisation helpers for tests (#614).
 *
 * Prefer these over fixed `setTimeout` sleeps: they wait for work that is
 * actually queued rather than guessing how long it takes.
 */
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import type { Socket } from 'socket.io-client';

/**
 * Drains the microtask queue and pending `setImmediate` callbacks, repeating
 * until `rounds` consecutive macrotask turns have passed. This lets chained
 * fire-and-forget work (`setImmediate(() => promise.then(...))`) settle.
 */
export async function flushUntilIdle(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

/** Starts `server` on an OS-assigned port (`port: 0`) and resolves the port. */
export function listenOnEphemeralPort(server: Server): Promise<number> {
  return new Promise(resolve => {
    server.listen({ port: 0 }, () => resolve((server.address() as AddressInfo).port));
  });
}

/** Resolves with the first payload the client receives for `event`. */
export function waitForSocketEvent<T = unknown>(socket: Socket, event: string): Promise<T> {
  return new Promise(resolve => {
    socket.once(event, (payload: T) => resolve(payload));
  });
}

/** Emits `join_shipment` and awaits the server's `room_joined` acknowledgement. */
export async function joinShipmentRoom(socket: Socket, shipmentId: string): Promise<void> {
  const joined = waitForSocketEvent(socket, 'room_joined');
  socket.emit('join_shipment', shipmentId);
  await joined;
}
