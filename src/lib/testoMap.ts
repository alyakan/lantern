/**
 * The Testo sensor integration's map (from a real Architecture chat, 14 October), in the layered format: a fixture for
 * the tests and the mock backend's Architecture run. Two issues are Claude's; one boundary crossing Lantern finds itself
 * (the sensor field reaching the Testo device past the device protocols).
 */
export const TESTO_MAP = {
  layers: [
    { id: "ui", label: "UI" },
    { id: "logic", label: "Business logic" },
    { id: "boundary", label: "Device boundary" },
    { id: "impl", label: "Testo implementation" },
    { id: "external", label: "External" },
  ],
  nodes: [
    { id: "field", label: "Sensor field and view model", layer: "ui", status: "planned", note: "connect, take a measurement, show the result, delete; a placeholder shows today" },
    { id: "sheet", label: "Paired sensors sheet", layer: "ui", status: "planned", note: "lists paired sensors, Add sensor, remove; returns the picked device" },
    { id: "gate", label: "Gating", layer: "logic", status: "done", note: "local flag, SensorSupport (iOS 18), SensorQuestionAvailability" },
    { id: "answer", label: "Answer type and storage", layer: "logic", status: "done", note: "sensor_measurement decode, Realm model, recorder, flat upload JSON" },
    { id: "boundary", label: "MeasuringDevice protocols", layer: "boundary", status: "done", note: "vendor-neutral MeasuringDevice and MeasuringDevicePairing, state and errors" },
    { id: "tdev", label: "TestoMeasuringDevice", layer: "impl", status: "planned", note: "Core Bluetooth: one connection, timeout, reconnect, unlock, device info, window" },
    { id: "tpair", label: "TestoAccessoryPairing", layer: "impl", status: "planned", note: "AccessorySetupKit picker, paired list, labels, remove" },
    { id: "parse", label: "GATT parsing", layer: "impl", status: "done", note: "TestoGATT ids, readings, sensor events, value subscription, device info" },
    { id: "unlock", label: "Unlock flow and credentials", layer: "impl", status: "done", note: "TestoUnlockFlow state machine, TestoCredentials" },
    { id: "window", label: "Window events and expected quantities", layer: "impl", status: "in-progress", note: "TestoWindowEvent and expected readings done; the window reducer is still to write", issue: "holds the probe rules and the timeout policy: two jobs in one type" },
    { id: "cred", label: "Credentials store", layer: "impl", status: "planned", note: "GET /v2/testo-credentials after login, one Keychain item" },
    { id: "handle", label: "Testo Saveris handle", layer: "external", note: "BLE sensor; sends a reading when its button is pressed" },
    { id: "api", label: "Lumiform backend", layer: "external", note: "templates, uploads, Testo credentials and the org addon" },
  ],
  edges: [
    { from: "field", to: "sheet", label: "picks a device" },
    { from: "field", to: "boundary", label: "connect, measure" },
    { from: "sheet", to: "boundary", label: "paired devices" },
    { from: "field", to: "gate", label: "capture or unsupported" },
    { from: "field", to: "answer", label: "save or remove answer" },
    { from: "field", to: "tdev", label: "battery level" },
    { from: "tdev", to: "boundary", label: "implements" },
    { from: "tpair", to: "boundary", label: "implements" },
    { from: "tdev", to: "parse", label: "characteristic values" },
    { from: "tdev", to: "unlock", label: "unlock" },
    { from: "parse", to: "window", label: "sensor events" },
    { from: "cred", to: "unlock", label: "company and key" },
    { from: "tdev", to: "handle", label: "BLE" },
    { from: "cred", to: "api", label: "credentials", issue: "fetched on every login with no expiry: a stale key fails the unlock silently" },
    { from: "answer", to: "api", label: "answer JSON" },
  ],
};
