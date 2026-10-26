// -----------------------------------------------------------------------------
// Known Remootio devices -> Gladys devices and values (pure).
//
// A known Remootio (a record of `devices` in /data, see src/store.js) becomes
// one Gladys device whose external ids are built from its serial number:
// `gladys.externalIds('remootio', serial)`, whatever its address. Feature keys
// are frozen:
//
//   door         opening sensor (read only): closed / not closed
//   open, close  BUTTONS (push), never a switch
//
// The door is never a switch nor a commandable binary: a "turn everything
// off/on" (voice assistants, HomeKit, scenes on switches) must never reach a
// gate or a garage door.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { EXTERNAL_ID_TYPE, OPENING_SENSOR_STATE } from './constants.js';
import { FEATURE_NAMES, word } from './i18n.js';
import { STATE } from './remootio/protocol.js';

const button = () => ({
  category: C.BUTTON,
  type: T.BUTTON.PUSH,
  min: 0,
  max: 1,
  read_only: false,
  has_feedback: false,
  keep_history: false,
});

/** The features of a Remootio: `[{ key, spec, name }]`, in a stable order. */
export function featuresOf() {
  return [
    {
      key: 'door',
      spec: {
        category: C.OPENING_SENSOR,
        type: T.SENSOR.BINARY,
        min: 0,
        max: 1,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      name: FEATURE_NAMES.door,
    },
    { key: 'open', spec: button(), name: FEATURE_NAMES.open },
    { key: 'close', spec: button(), name: FEATURE_NAMES.close },
  ];
}

export function deviceName(record) {
  return `Remootio ${record.serial.slice(-6)}`;
}

/** The Gladys device of a known Remootio. */
export function buildDevice(gladys, record, { language }) {
  const ids = gladys.externalIds(EXTERNAL_ID_TYPE, record.serial);
  const features = featuresOf().map(({ key, spec, name }) => ({
    name: word(name, language).slice(0, 100),
    external_id: ids.feature(key),
    ...spec,
  }));
  const params = [
    { name: 'IP_ADDRESS', value: record.address ?? '' },
    { name: 'SERIAL_NUMBER', value: record.serial },
    { name: 'MODEL', value: record.model ?? '' },
  ].filter((param) => param.value !== '');
  return {
    name: deviceName(record),
    external_id: ids.device,
    features,
    params,
    should_poll: false,
  };
}

/** The value of the door feature for a state of the API; undefined without a sensor. */
export function doorValue(state) {
  if (state === STATE.CLOSED) return OPENING_SENSOR_STATE.CLOSE;
  if (state === STATE.OPEN) return OPENING_SENSOR_STATE.OPEN;
  return undefined;
}
