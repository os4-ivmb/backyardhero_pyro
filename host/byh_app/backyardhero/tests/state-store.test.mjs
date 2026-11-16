import assert from 'node:assert/strict';
import test from 'node:test';
import useStateAppStore from '../src/store/useStateAppStore.js';

test('heartbeats preserve operator state and receiver identity', () => {
  const store = useStateAppStore;
  const now = Date.now();
  store.getState().handleSocketMessage({ fw_last_update: now, fw_state: { daemon_active: true, receivers: { a: { status: { lmt: now } } } }, fw_system: { temp: 45 } });
  const before = store.getState().stateData;
  store.getState().handleSocketMessage({ _hb: true, fw_last_update: now + 1, daemon_active: true, daemon_lup: now + 1, fw_system: { temp: 45 } });
  assert.equal(store.getState().stateData, before);
  store.getState().handleSocketMessage({ _hb: true, fw_last_update: now + 2, daemon_active: true, fw_system: { temp: 46 } });
  assert.equal(store.getState().stateData.fw_state.receivers, before.fw_state.receivers);
  store.getState().handleSocketMessage({ _hb: true, daemon_active: false });
  assert.equal(store.getState().stateData.fw_state.daemon_active, false);
  assert.equal(store.getState().stateData.fw_state.receivers, before.fw_state.receivers);
});

test('full snapshots retain unchanged receivers while live changes propagate', () => {
  const store = useStateAppStore;
  const frame = { fw_state: { receivers: { a: { status: { lmt: 1 } }, b: { status: { lmt: 2 } } } } };
  store.getState().setStateData(frame);
  const before = store.getState().stateData;
  store.getState().setStateData(JSON.parse(JSON.stringify(frame)));
  assert.equal(store.getState().stateData, before);
  store.getState().setStateData({ fw_state: { receivers: { a: { status: { lmt: 3 } }, b: { status: { lmt: 2 } } } } });
  const after = store.getState().stateData;
  assert.notEqual(after.fw_state.receivers.a, before.fw_state.receivers.a);
  assert.equal(after.fw_state.receivers.b, before.fw_state.receivers.b);
});
