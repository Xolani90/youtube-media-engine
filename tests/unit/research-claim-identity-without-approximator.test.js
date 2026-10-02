import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveClaimIdentity } from '../../src/research/claimIdentity.js';

// Pass 43: two proven false-positive classes in identityTextConflict, found by
// replaying the recorded Pass 40 (HEAD 5fad04f) identities through the real validator.
//   1. polarity: "without <phrase>" is an adjunct (how the proposition holds), not
//      negation of the proposition. It is set aside ONLY when the identity itself
//      carries the adjunct; every other negation cue is still seen.
//   2. modality: a NON-numeric approximator over a span ("for more than a decade",
//      "nearly a year", "almost anyone") is not hedging. Set aside ONLY when the
//      identity carries cue+operand; numeric bounds and every real modal cue still veto.
const derive = (claim, identity) => deriveClaimIdentity({ claim, claim_type: 'FACT', is_load_bearing: true, identity });
const ident = (over = {}) => ({
  subject: 'Argon', predicate: 'ship', object: null, qualifiers: [], time: null,
  quantity: null, unit: null, polarity: 'AFFIRMED', modality: 'OCCURRED', relation: 'DESCRIPTIVE', ...over
});

// Real Pass 40 identities that were vetoed and are now accepted (7 of the 18).
const NOW_ACCEPTED = [
  {
    "claim": "Google spent most of September 30, 2026 as the most powerful AI lab in the world without letting almost anyone use its newest model.",
    "identity": {
      "subject": "Google",
      "predicate": "spend",
      "object": "most of September 30 , 2026 as the most powerful AI lab in the world without letting almost anyone use its newest model",
      "qualifiers": [],
      "time": "2026-09-30",
      "quantity": null,
      "unit": null,
      "polarity": "AFFIRMED",
      "modality": "OCCURRED",
      "relation": "DESCRIPTIVE"
    }
  },
  {
    "claim": "Marcus has reported on the technology and online-gaming industries for more than a decade.",
    "identity": {
      "subject": "Marcus",
      "predicate": "report",
      "object": "on the technology and online-gaming industries",
      "qualifiers": [
        "for more than a decade"
      ],
      "time": null,
      "quantity": null,
      "unit": null,
      "polarity": "AFFIRMED",
      "modality": "OCCURRED",
      "relation": "DESCRIPTIVE"
    }
  },
  {
    "claim": "For trusted defenders and our own internal teams at Google, we’ll be releasing Argon without cyber guardrails so they can leverage its full frontier-level cybersecurity defense capabilities.",
    "identity": {
      "subject": "we",
      "predicate": "release",
      "object": "Argon",
      "qualifiers": [
        "For trusted defenders and our own internal teams at Google",
        "without cyber guardrails",
        "so they can leverage its full frontier-level cybersecurity defense capabilities"
      ],
      "time": null,
      "quantity": null,
      "unit": null,
      "polarity": "AFFIRMED",
      "modality": "PLANNED",
      "relation": "DESCRIPTIVE"
    }
  },
  {
    "claim": "On Wiz’s internal black-box penetration testing benchmark, which tests a model’s ability to analyze live web systems without source code, Argon outperforms 3.8 Flash Cyber in discovering the attack surface, identifying vulnerabilities, and producing proof-of-concept evidence to validate them.",
    "identity": {
      "subject": "Argon",
      "predicate": "outperform",
      "object": "3.8 Flash Cyber",
      "qualifiers": [
        "On Wiz’s internal black-box penetration testing benchmark, which tests a model’s ability to analyze live web systems without source code",
        "in discovering the attack surface, identifying vulnerabilities, and producing proof-of-concept evidence to validate them"
      ],
      "time": null,
      "quantity": null,
      "unit": null,
      "polarity": "AFFIRMED",
      "modality": "OCCURRED",
      "relation": "DESCRIPTIVE"
    }
  },
  {
    "claim": "For trusted defenders, Google says Argon ships without cyber guardrails; the rest of this page keeps the dated rumor record that led here.",
    "identity": {
      "subject": "Google",
      "predicate": "say",
      "object": "Argon ships without cyber guardrails",
      "qualifiers": [
        "For trusted defenders"
      ],
      "time": null,
      "quantity": null,
      "unit": null,
      "polarity": "AFFIRMED",
      "modality": "OCCURRED",
      "relation": "DESCRIPTIVE"
    }
  },
  {
    "claim": "Argon is already being used internally to optimize memory at Google's data centers, freeing up hundreds of terabytes of memory without buying additional hardware, the company said.",
    "identity": {
      "subject": "Argon",
      "predicate": "used",
      "object": "internally to optimize memory at Google's data centers",
      "qualifiers": [
        "already",
        "freeing up hundreds of terabytes of memory without buying additional hardware",
        "the company said"
      ],
      "time": null,
      "quantity": null,
      "unit": null,
      "polarity": "AFFIRMED",
      "modality": "OCCURRED",
      "relation": "CAUSAL"
    }
  },
  {
    "claim": "Gemini 4 also launches nearly a year after Gemini 3 put the tech company back at the forefront of the heated AI model race.",
    "identity": {
      "subject": "Gemini 4",
      "predicate": "launches",
      "object": null,
      "qualifiers": [
        "also",
        "nearly a year after Gemini 3 put the tech company back at the forefront of the heated AI model race"
      ],
      "time": null,
      "quantity": null,
      "unit": null,
      "polarity": "AFFIRMED",
      "modality": "OCCURRED",
      "relation": "ASSOCIATIVE"
    }
  }
];

// Real Pass 40 identities that must STAY vetoed (11 of the 18), with the reason they had.
const STAY_VETOED = [
  {
    "claim": "Today it is limited to trusted cyber defenders through the Fairwind Program, with paid API customers and Google AI Ultra subscribers next and no date given, according to Google (2026).",
    "identity": {
      "original_claim": "Today it is limited to trusted cyber defenders through the Fairwind Program, with paid API customers and Google AI Ultra subscribers next and no date given, according to Google (2026).",
      "subject": "it",
      "predicate": "be",
      "object": "limited to trusted cyber defenders through the Fairwind Program",
      "qualifiers": [
        "Today",
        "with paid API customers and Google AI Ultra subscribers next and no date given",
        "according to Google (2026)"
      ],
      "time": null,
      "quantity": null,
      "unit": null,
      "polarity": "AFFIRMED",
      "modality": "OCCURRED",
      "relation": "DESCRIPTIVE"
    },
    "reason": "polarity_text_mismatch"
  },
  {
    "claim": "The output limit is 1 million tokens, up from 64,000, and Google has not stated an input context window ( MarkTechPost , 2026).",
    "identity": {
      "subject": "The output limit",
      "predicate": "be",
      "object": "1 million tokens",
      "qualifiers": [
        "up from 64,000",
        "and Google has not stated an input context window ( MarkTechPost , 2026)"
      ],
      "time": "2026",
      "quantity": 1000000,
      "unit": "tokens",
      "polarity": "AFFIRMED",
      "modality": "OCCURRED",
      "relation": "DESCRIPTIVE"
    },
    "reason": "polarity_text_mismatch"
  },
  {
    "claim": "Google states a 1 million token output limit for Gemini 4 Argon, up from 64,000 on earlier Gemini models, and does not state an input context window.",
    "identity": {
      "subject": "Google",
      "predicate": "state",
      "object": "a 1 million token output limit for Gemini 4 Argon, up from 64,000 on earlier Gemini models",
      "qualifiers": [
        "and does not state an input context window"
      ],
      "time": null,
      "quantity": 1000000,
      "unit": "tokens",
      "polarity": "AFFIRMED",
      "modality": "OCCURRED",
      "relation": "DESCRIPTIVE"
    },
    "reason": "polarity_text_mismatch"
  },
  {
    "claim": "There is no firm date for when Google AI Ultra subscribers or ordinary developers will get access.",
    "identity": {
      "subject": "There",
      "predicate": "be",
      "object": "no firm date for when Google AI Ultra subscribers or ordinary developers will get access",
      "qualifiers": [],
      "time": null,
      "quantity": null,
      "unit": null,
      "polarity": "NEGATED",
      "modality": "OCCURRED",
      "relation": "DESCRIPTIVE"
    },
    "reason": "modality_text_mismatch"
  },
  {
    "claim": "Memory efficiency: A team of Argon agents analyzed fleet-wide profiling telemetry to autonomously identify and apply memory optimizations across Google’s data centers, freeing up over 300 TiB of memory once rolled out, with an estimated 500 TiB to 1 PiB in total savings.",
    "identity": {
      "subject": "A team of Argon agents",
      "predicate": "analyze",
      "object": "fleet-wide profiling telemetry",
      "qualifiers": [
        "Memory efficiency",
        "to autonomously identify and apply memory optimizations across Google’s data centers",
        "freeing up over 300 TiB of memory once rolled out",
        "with an estimated 500 TiB to 1 PiB in total savings"
      ],
      "time": null,
      "quantity": 300,
      "unit": "TiB",
      "polarity": "AFFIRMED",
      "modality": "OCCURRED",
      "relation": "CAUSAL"
    },
    "reason": "modality_text_mismatch"
  },
  {
    "claim": "Large Scale Codebase Migrations and Optimizations: Argon agents are working on migrating C/C++ codebases to Rust across Google — scaling from tens of thousands of lines in core libraries like re2, libgav1 up to 800K+ lines for the Fuchsia Zircon kernel.",
    "identity": {
      "subject": "Argon agents",
      "predicate": "work",
      "object": "on migrating C/C++ codebases to Rust across Google",
      "qualifiers": [
        "Large Scale Codebase Migrations and Optimizations",
        "scaling from tens of thousands of lines in core libraries like re2, libgav1 up to 800K+ lines for the Fuchsia Zircon kernel"
      ],
      "time": null,
      "quantity": null,
      "unit": null,
      "polarity": "AFFIRMED",
      "modality": "OCCURRED",
      "relation": "DESCRIPTIVE"
    },
    "reason": "modality_text_mismatch"
  },
  {
    "claim": "We used a similar system to monitor our training runs and send alerts to a dedicated incident response team, taking careful precautions against feeding the findings back into training so as to not risk shaping Argon’s reasoning to evade our monitoring.",
    "identity": {
      "subject": "We",
      "predicate": "use",
      "object": "a similar system",
      "qualifiers": [
        "to monitor our training runs and send alerts to a dedicated incident response team",
        "taking careful precautions against feeding the findings back into training so as to not risk shaping Argon’s reasoning to evade our monitoring"
      ],
      "time": null,
      "quantity": null,
      "unit": null,
      "polarity": "AFFIRMED",
      "modality": "OCCURRED",
      "relation": "DESCRIPTIVE"
    },
    "reason": "polarity_text_mismatch"
  },
  {
    "claim": "We’re grateful for the initial cohort of cyber defenders and trusted testers whose real-world evaluations and feedback will help us strengthen our systems before we release to developers, enterprises, and consumers, starting with paid API customers and Google AI Ultra subscribers.",
    "identity": {
      "subject": "We",
      "predicate": "be",
      "object": "grateful for the initial cohort of cyber defenders and trusted testers whose real-world evaluations and feedback will help us strengthen our systems before we release to developers, enterprises, and consumers, starting with paid API customers and Google AI Ultra subscribers",
      "qualifiers": [],
      "time": null,
      "quantity": null,
      "unit": null,
      "polarity": "AFFIRMED",
      "modality": "OCCURRED",
      "relation": "DESCRIPTIVE"
    },
    "reason": "modality_text_mismatch"
  },
  {
    "claim": "On September 30, 2026, Google announced “our new frontier model, Gemini 4 Argon, which is rolling out to a set of trusted cyber defenders through our Fairwind Program.”",
    "identity": {
      "subject": "Google",
      "predicate": "announce",
      "object": "our new frontier model, Gemini 4 Argon, which is rolling out to a set of trusted cyber defenders through our Fairwind Program",
      "qualifiers": [
        "through our Fairwind Program"
      ],
      "time": "2026-09-30",
      "quantity": null,
      "unit": null,
      "polarity": "AFFIRMED",
      "modality": "OCCURRED",
      "relation": "DESCRIPTIVE"
    },
    "reason": "modality_text_mismatch"
  },
  {
    "claim": "Google announced Gemini 4 Argon on September 30, 2026, its new frontier model, rolling out first to trusted cyber defenders through its Fairwind Program.",
    "identity": {
      "subject": "Google",
      "predicate": "announce",
      "object": "Gemini 4 Argon",
      "qualifiers": [
        "on September 30, 2026",
        "its new frontier model",
        "rolling out first to trusted cyber defenders through its Fairwind Program"
      ],
      "time": "2026-09-30",
      "quantity": null,
      "unit": null,
      "polarity": "AFFIRMED",
      "modality": "OCCURRED",
      "relation": "DESCRIPTIVE"
    },
    "reason": "modality_text_mismatch"
  },
  {
    "claim": "Google announced Gemini 4 Argon on September 30, 2026. It is rolling out to trusted cyber defenders through the Fairwind Program first, then to paid API customers and Google AI Ultra subscribers.",
    "identity": {
      "subject": "Google",
      "predicate": "announce",
      "object": "Gemini 4 Argon",
      "qualifiers": [
        "on September 30, 2026"
      ],
      "time": "2026-09-30",
      "quantity": null,
      "unit": null,
      "polarity": "AFFIRMED",
      "modality": "OCCURRED",
      "relation": "DESCRIPTIVE"
    },
    "reason": "modality_text_mismatch"
  }
];

test('A. the 7 recorded false-positive claims are now fingerprinted', () => {
  for (const c of NOW_ACCEPTED) {
    const r = derive(c.claim, c.identity);
    assert.equal(r.reason, null, c.claim);
    assert.match(r.fingerprint, /^[0-9a-f]{64}$/);
  }
});

test('B. the other recorded polarity/modality vetoes keep their exact reason', () => {
  for (const c of STAY_VETOED) {
    const r = derive(c.claim, c.identity);
    assert.equal(r.reason, c.reason, c.claim);
    assert.equal(r.fingerprint, null);
  }
});

test('C. genuine negation is still rejected when labelled AFFIRMED, accepted when NEGATED', () => {
  const base = { subject: 'Google', predicate: 'state', object: 'the launch date' };
  assert.equal(derive('Google has not stated the launch date.', ident(base)).reason, 'polarity_text_mismatch');
  assert.equal(derive('Google has not stated the launch date.', ident({ ...base, polarity: 'NEGATED' })).reason, null);
  assert.equal(derive('Google does not support this configuration.', ident({ subject: 'Google', predicate: 'support', object: 'this configuration' })).reason, 'polarity_text_mismatch');
  assert.equal(derive('There is no announced launch date.', ident({ subject: 'There', predicate: 'be', object: 'no announced launch date' })).reason, 'polarity_text_mismatch');
});

test('D. a "without" adjunct carried by the identity is not a negation', () => {
  assert.equal(derive('Argon ships without source code.', ident({ object: 'without source code' })).reason, null);
  assert.equal(derive('Argon works without buying additional memory.', ident({ predicate: 'work', qualifiers: ['without buying additional memory'] })).reason, null);
  assert.equal(derive('The model was released without cyber guardrails.', ident({ subject: 'model', predicate: 'release', qualifiers: ['without cyber guardrails'] })).reason, null);
});

test('E. a "without" adjunct the identity dropped stays vetoed (fingerprint could not tell it apart)', () => {
  assert.equal(derive('The model was released without cyber guardrails.', ident({ subject: 'model', predicate: 'release' })).reason, 'polarity_text_mismatch');
});

test('F. another negation next to an accounted "without" adjunct is still seen', () => {
  assert.equal(derive('Google did not ship Argon without cyber guardrails.', ident({ subject: 'Google', object: 'Argon', qualifiers: ['without cyber guardrails'] })).reason, 'polarity_text_mismatch');
});

test('G. a NEGATED label cannot be justified by an accounted "without" adjunct alone', () => {
  assert.equal(derive('Argon ships without source code.', ident({ object: 'without source code', polarity: 'NEGATED' })).reason, 'polarity_text_mismatch');
});

test('H. real modal/hedge wording still vetoes an OCCURRED label', () => {
  for (const claim of ['Google may release Argon.', 'Google could release Argon.', 'Google plans to release Argon.', 'Google is expected to release Argon.']) {
    assert.equal(derive(claim, ident({ subject: 'Google', predicate: 'release', object: 'Argon' })).reason, 'modality_text_mismatch', claim);
  }
});

test('I. a non-numeric approximator carried by the identity is not modality', () => {
  assert.equal(derive('The company has operated for more than a decade.', ident({ subject: 'company', predicate: 'operate', qualifiers: ['for more than a decade'] })).reason, null);
  assert.equal(derive('The model was available for nearly a year.', ident({ subject: 'model', predicate: 'be', qualifiers: ['available for nearly a year'] })).reason, null);
});

test('J. the same approximator the identity dropped stays vetoed', () => {
  assert.equal(derive('The company has operated for more than a decade.', ident({ subject: 'company', predicate: 'operate' })).reason, 'modality_text_mismatch');
});

test('K. numeric and spelled-number bounds still veto an OCCURRED label', () => {
  assert.equal(derive('The company has more than 500 employees.', ident({ subject: 'company', predicate: 'have', object: 'employees', quantity: 500, unit: 'employees' })).reason, 'modality_text_mismatch');
  assert.equal(derive('Argon scales up to 800K lines.', ident({ predicate: 'scale', object: 'lines', qualifiers: ['up to 800k lines'] })).reason, 'modality_text_mismatch');
  assert.equal(derive('The company employs nearly a dozen people.', ident({ subject: 'company', predicate: 'employ', object: 'people', qualifiers: ['nearly a dozen people'] })).reason, 'modality_text_mismatch');
});

test('L. a real hedge beside an accounted approximator is still seen', () => {
  assert.equal(derive('The company has operated for more than a decade and will expand.', ident({ subject: 'company', predicate: 'operate', qualifiers: ['for more than a decade and will expand'] })).reason, 'modality_text_mismatch');
});

test('M. fingerprints differ when the adjunct/approximator differs (no new false merges)', () => {
  const a = derive('Argon ships without source code.', ident({ object: 'without source code' }));
  const b = derive('Argon ships with source code.', ident({ object: 'with source code' }));
  assert.notEqual(a.fingerprint, b.fingerprint);
  const c = derive('The company has operated for more than a decade.', ident({ subject: 'company', predicate: 'operate', qualifiers: ['for more than a decade'] }));
  const d = derive('The company has operated for a decade.', ident({ subject: 'company', predicate: 'operate', qualifiers: ['for a decade'] }));
  assert.notEqual(c.fingerprint, d.fingerprint);
});
