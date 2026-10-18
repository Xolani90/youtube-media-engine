// Loaded by `npm test` via --import. The engine default narration provider is Kokoro
// (neural, slow on CPU, needs model files). The suite must stay fast and offline, so it
// pins espeak-ng unless a test sets NARRATION_PROVIDER itself. This affects the test
// process only; it never changes the engine default.
process.env.NARRATION_PROVIDER ??= 'espeak-ng';
