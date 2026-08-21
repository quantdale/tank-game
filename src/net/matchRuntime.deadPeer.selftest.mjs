// A channel that turns unwritable between ticks (peer closed the tab, radio
// drop) used to throw TransportClosedError out of advance(), which terminated
// the whole authoritative match service. The authority must instead detach the
// vanished peer and keep stepping the match for everyone else.
import assert from 'node:assert/strict';
import { MESSAGE_TYPES, createEnvelope } from './protocol.js';
import { TransportClosedError } from './loopbackTransport.js';
import { captureWorldSnapshot } from './snapshot.js';
import { AuthoritativeMatchRuntime } from './matchRuntime.js';

function createTestSimulation() {
  const entities = new Map();
  return {
    entities,
    onPeerJoin({ peerId }) {
      entities.set(peerId, {
        id: peerId,
        specId: 'm1a2',
        team: 'alpha',
        spotted: true,
        state: {
          pos: { x: 0, y: 2, z: 3 },
          yaw: 0,
          speed: 0,
          verticalSpeed: 0,
          grounded: true,
          visualPitch: 0,
          visualRoll: 0,
          turretYaw: 0,
          gunPitch: 0,
        },
        input: { fire: false },
        combat: {
          hp: 900,
          maxHp: 1000,
          destroyed: false,
          fire: { burning: false },
          reload: { t: 1.25, totalS: 18.5, kind: 'magazine' },
          magazine: { rounds: 1, capacity: 3 },
        },
      });
    },
    onPeerLeave({ peerId }) { entities.delete(peerId); },
    step() {},
    snapshot({ tick, serverTimeMs, viewerId, ackInputSeq }) {
      return captureWorldSnapshot({
        tick,
        serverTimeMs,
        entities: [...entities.values()],
        viewerId,
        ackInputSeq,
        canObserve: () => true,
      });
    },
  };
}

function closingTransport(sendStateError) {
  const listeners = new Set();
  return {
    kind: 'channel',
    readyState: 'open',
    send(message) { return sendStateError ? sendStateError(message) : true; },
    sendState(message) { return sendStateError ? sendStateError(message) : true; },
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onClose() { return () => {}; },
    deliver(raw) {
      for (const listener of [...listeners]) listener(raw);
    },
    close() { this.readyState = 'closed'; },
  };
}

function helloEnvelope(peerId) {
  return createEnvelope(MESSAGE_TYPES.HELLO, { playerId: peerId }, { seq: 0, tick: 0 });
}

{
  const host = new AuthoritativeMatchRuntime({ simulation: createTestSimulation() });
  let controlSends = 0;
  const transport = closingTransport((message) => {
    if (message.type === MESSAGE_TYPES.SNAPSHOT) throw new TransportClosedError();
    controlSends++;
    return true;
  });
  host.attachPeer({ peerId: 'p1', transport });
  transport.deliver(helloEnvelope('p1'));
  assert.equal(host.peers.get('p1').welcomed, true,
    'handshake completes while the reliable lane still works');
  assert.ok(controlSends >= 1, 'WELCOME rode the reliable lane');

  // Snapshot broadcast hits the dying channel: must detach, not crash.
  for (let i = 0; i < 10; i++) host.advance(1000 / 60);
  assert.ok(host.stats.snapshots >= 1, 'the broadcast path actually ran');
  assert.equal(host.peers.has('p1'), false,
    'a transport that fails mid-broadcast is detached as a disconnect');
  assert.equal(host.stats.steps, 10, 'every tick still completed');
  // The next tick keeps stepping the match for any remaining peers.
  host.advance(1000 / 60);
  host.close();
}

{
  // Same failure arriving through the reliable control lane (the WELCOME
  // reply to HELLO) must also detach instead of surfacing into callers.
  const host = new AuthoritativeMatchRuntime({ simulation: createTestSimulation() });
  const transport = closingTransport(() => { throw new TransportClosedError(); });
  host.attachPeer({ peerId: 'p2', transport });
  transport.deliver(helloEnvelope('p2'));
  assert.equal(host.peers.has('p2'), false,
    'a transport that fails the handshake reply is detached as a disconnect');
  host.advance(1000 / 60);
  host.close();
}

{
  // Programming errors are not masked: only transport closure is absorbed.
  const host = new AuthoritativeMatchRuntime({ simulation: createTestSimulation() });
  const transport = closingTransport(() => { throw new TypeError('bad codec'); });
  host.attachPeer({ peerId: 'p3', transport });
  assert.throws(() => transport.deliver(helloEnvelope('p3')), TypeError,
    'unexpected send failures still surface to the caller');
  assert.equal(host.peers.has('p3'), true, 'non-closure failures never detach silently');
  host.close();
}

console.log('matchRuntime.deadPeer.selftest: vanished transports detach without killing the authority');
