# Preregistration: SigLIP scene-relevance evaluation v2

Status: PRE-FREEZE DRAFT. This file becomes binding only when `scripts/eval-scene-relevance-v2-freeze.js`
writes `judgments-manifest.json`; at that moment it records the SHA-256 of this file, `scenes.json`,
`negatives.json`, `candidates.json` and `answer-key.json`, together with the SHA-256 of the bytes of every
evaluated candidate image, and the run and report scripts refuse to proceed if any of them
changed. Until that manifest exists, correcting this file is legitimate and no result depends on it; the
final text must be settled before the first freeze, because the freeze script hashes whatever is on disk.
Nothing below may be changed after the freeze, and nothing may be changed after seeing scores. Evaluation authorisation here is separate from
production authorisation (see section 12).

## 1. Purpose

Test whether SigLIP (existing worker `src/media/sceneRelevanceWorker.js`, unchanged) ranks candidate
stock photos for a scene description better than taking the first Pixabay result, on 30 new scenes
and 20 negative sets. This is exploratory evidence, not proof of general performance.

## 2. Dataset (30 scenes, 6 categories x 5)

Descriptions, queries and acceptable visual proxies are fixed here. A candidate may be called relevant only
if it matches the scene's visualTarget or one of its proxies as written; scenes are never redefined after
looking at images. Abstract scenes (category F) are judged through their listed proxies.

| Scene | Split | Description | Pixabay query | Acceptable visual proxies |
|---|---|---|---|---|
| A01 | heldout | Wind turbines turning on a ridge at sunrise. | `wind turbines ridge sunrise` | wind turbines at dawn or golden hour on high ground |
| A02 | calibration | A crane lifting steel beams over a partially built skyscraper. | `crane steel beams skyscraper construction` | tower crane lifting a load at an unfinished tall building |
| A03 | calibration | Passengers queuing in an airport check-in hall. | `passengers queue airport check-in` | queue at airport check-in or baggage drop |
| A04 | heldout | A coal train crossing open plains. | `coal train open plains` | long train of loaded coal wagons in open landscape |
| A05 | heldout | Rescue workers wading through a flooded street. | `rescue workers flooded street` | rescuers or emergency workers in flooded urban or village street |
| B01 | heldout | A bank teller counting banknotes. | `bank teller counting banknotes` | cashier or teller counting cash by hand or machine |
| B02 | heldout | Shoppers comparing prices on supermarket shelves. | `shoppers supermarket shelves prices` | customers reading shelf price tags in a grocery store |
| B03 | calibration | A for-sale sign outside a house. | `for sale sign house` | for-sale or sold board in the front garden of a home |
| B04 | calibration | A jeweller weighing gold bars. | `jeweller weighing gold bars` | gold bullion being weighed or inspected |
| B05 | heldout | A currency exchange board displaying rates. | `currency exchange board rates` | bureau de change rate display with several currencies |
| C01 | heldout | A developer coding on multiple monitors. | `developer coding multiple monitors` | programmer with two or more screens of code |
| C02 | heldout | A robot arm assembling electronics. | `robot arm assembling electronics` | robotic arm on an electronics production line |
| C03 | calibration | A smartphone displaying a social media feed. | `smartphone social media feed` | hand holding phone with social network timeline visible |
| C04 | heldout | Fibre-optic cables in a network cabinet. | `fibre optic cables network cabinet` | rack with illuminated fibre or patch cables |
| C05 | calibration | A drone flying over farmland. | `drone flying over farmland` | agricultural drone above crops or fields |
| D01 | heldout | A surgical team in an operating theatre. | `surgical team operating theatre` | surgeons in scrubs around an operating table |
| D02 | heldout | Researchers sampling a polluted river. | `researchers sampling polluted river water` | scientists collecting river water samples; visibly polluted river with sampling activity |
| D03 | calibration | A greenhouse containing rows of tomato plants. | `greenhouse rows tomato plants` | tomato crop in a polytunnel or glasshouse |
| D04 | heldout | An astronomer observing through a telescope at night. | `astronomer telescope night observatory` | observer at a large telescope in darkness |
| D05 | calibration | A glacier melting into a lake. | `glacier melting lake` | glacier terminus in a proglacial lake; icebergs calving into a glacial lake |
| E01 | heldout | A courtroom with a judge and lawyers. | `courtroom judge lawyers` | judge on the bench with counsel present |
| E02 | heldout | Voters queuing at a polling station. | `voters queue polling station` | queue of voters outside or inside a polling station |
| E03 | calibration | A parliament chamber during a debate. | `parliament chamber debate` | members of parliament in session in the chamber |
| E04 | heldout | Police directing a crowd at a protest. | `police directing crowd protest` | police line or officers with protesters |
| E05 | calibration | A teacher addressing a classroom of children. | `teacher addressing classroom children` | teacher teaching pupils in a classroom |
| F01 | heldout | Inflation squeezing household budgets. | `inflation household budget prices` | shopper looking at high prices; grocery receipt or bills with calculator; hand counting few coins over groceries; price tags on food |
| F02 | heldout | A data breach and loss of trust. | `data breach hacker security` | hooded hacker at a computer; open or broken padlock on a keyboard; warning on screen about compromised data |
| F03 | calibration | Supply-chain disruption. | `supply chain disruption port containers` | congested container port; ships waiting at port; empty shelves in shops; lorries queuing |
| F04 | heldout | Misinformation spreading online. | `fake news misinformation social media` | phone or screen showing fake-news headline; social network icons with warning; person reading questionable online news |
| F05 | calibration | Inequality between rich and poor neighbourhoods. | `rich poor neighbourhood inequality` | slum next to luxury high-rises; contrasting housing quality side by side |

## 3. Candidate acquisition (Stage B/C, not Stage A)

One Pixabay search per scene (`image_type=photo`, `safesearch=true`, `per_page=20`, default order).
Eight candidates at evenly spaced 0-based positions floor(i*n/8), i=0..7 (0,2,5,7,10,12,15,17 for n=20),
candidate IDs `<scene>-A..H`. The first position is Pixabay search rank 1, which is the "Pixabay-first"
baseline. Recorded per candidate: query, hit IDs, search rank, Pixabay ID, page URL, SHA-256, bytes,
format; per scene: every download failure. A scene needs >= 6 downloaded candidates, otherwise the fetch
stops and the owner decides (no silent query change). 240 positive images in total.

Insufficient scenes fail closed. A scene with fewer than 6 usable hits or fewer than 6 downloaded candidates is
recorded in `candidates.json` as `status: insufficient` (with its reason and time) and the run stops. While any
scene is insufficient or in an unrecognised state, every later fetch run (any group, any `--only`, also
`--dry-run`) refuses to proceed before any network call. The only way forward is an explicit owner decision in
`fetch-owner-decisions.json` (decision `retry-same-query`, deciding person, ISO date, reason), bound to the SHA-256
of that exact recorded failure, so a decision cannot approve a later failure. `--show-insufficient` (offline)
prints each hash and a template. An approved retry first moves the old record into `attemptHistory` and its images
to `images/<scene>.attempt<N>/`; nothing collected is deleted or overwritten. Changing the query is not a fetch
decision: it changes `scenes.json` or `negatives.json` and needs a new preregistration.

## 4. Calibration / held-out split (stratified, deterministic)

Within each category, sort the five scene IDs ascending by the lowercase hex SHA-256 of the UTF-8 ID
string. The first two are calibration, the remaining three are held-out. This gives 12 calibration and 18
held-out scenes, every category present in both. The tooling recomputes this and rejects any mismatch.

| Category | Calibration | Held-out |
|---|---|---|
| A | A02, A03 | A01, A04, A05 |
| B | B03, B04 | B01, B02, B05 |
| C | C03, C05 | C01, C02, C04 |
| D | D03, D05 | D01, D02, D04 |
| E | E03, E05 | E01, E02, E04 |
| F | F03, F05 | F01, F02, F04 |

Near-miss split (rule fixed before any score or image existed; no model output is used). The ten near-miss items
are stratified by `conditionType`: within each condition type, sort the near-miss IDs ascending by the lowercase
hex SHA-256 of `nmsplit:` + ID (tie-breaker, were two hashes ever equal: the ID, ascending); the first floor(n/2)
are calibration and the rest (the extra item when n is odd) are held-out. The prefix `nmsplit:` was declared once
and computed once; no alternative prefix was tried. This replaces the earlier split, which had put all four
absence items in held-out. The tooling recomputes the rule and rejects any `negatives.json` that differs.

| Condition type | Calibration | Held-out |
|---|---|---|
| absence (4) | NM06, NM04 | NM02, NM08 |
| visual / ordinary (6) | NM10, NM07, NM01 | NM05, NM03, NM09 |

Why stratified: a pure global "lowest 15 hashes" split leaves category C with no held-out scenes, which
would make a per-category criterion impossible. The owner approved the stratified split.

## 5. Negative sets (unsuitable-image detection)

Mixed into the same blind sheet as the positive scenes (50 items), so the reviewer is not told which are
negatives and sees no model output. Items appear in a random order stored in a private answer key
(`answer-key.json`, created once with cryptographic randomness); the reviewer sees only random opaque item and
candidate IDs, with the display labels J01-J50 following that random order. This is partial blinding, not full
blindness (see section 11).

How the negative sets are interpreted. The ten cross-category items are SUPPLEMENTARY GROSS-MISMATCH SANITY
CHECKS. They pair a description with photos of an unrelated subject, are mostly easy negatives, and must not be
presented as evidence of strong fine-grained visual discrimination. The ten near-miss items are provisional and
are reported in two separate groups: ordinary near-misses (`conditionType: visual`: NM01, NM03, NM05, NM07, NM09,
NM10) and absence/negation cases (`conditionType: absence`: NM02, NM04, NM06, NM08), which depend on "empty" or
"no one" and therefore also test negation handling. Absence cases are never used to support a claim about
ordinary scene relevance, and they are never removed from the overall result either: the inclusive result keeps
every eligible item, and the subgroups are diagnostic. By the frozen split calibration and held-out each hold 3
ordinary near-misses and 2 absence cases (section 4); the report prints these designed counts.

Cross-category (10, reuse existing candidates, no extra downloads). Rule: per split, sort scene IDs by
sha256('xneg:'+id); the first 5 are description scenes. The image scene is the scene in a different
category with the lowest sha256('xneg-img:'+d+':'+m).

| Item | Description scene | Image scene | Split |
|---|---|---|---|
| XN01 | F05 | C04 | calibration |
| XN02 | C05 | A03 | calibration |
| XN03 | C03 | E05 | calibration |
| XN04 | A03 | D02 | calibration |
| XN05 | F03 | C03 | calibration |
| XN06 | E04 | B04 | heldout |
| XN07 | F02 | E01 | heldout |
| XN08 | B01 | E04 | heldout |
| XN09 | D04 | A03 | heldout |
| XN10 | C04 | D01 | heldout |

Near-miss (10, need 10 extra searches and up to 80 downloads in Stage C; none run in Stage A). The
description states a specific visual condition and the query returns the opposite or unaffected condition.

| Item | Description | Query | Split | Condition type |
|---|---|---|---|---|
| NM01 | Drought-damaged maize wilting in a cracked, dry field. | `green healthy maize field` | calibration | visual |
| NM02 | Empty supermarket shelves after panic buying. | `fully stocked supermarket shelves` | heldout | absence |
| NM03 | A flooded street with water up to the car windows. | `dry city street sunny day` | heldout | visual |
| NM04 | An empty operating theatre with no staff or patient. | `surgeons operating theatre team` | calibration | absence |
| NM05 | A wildfire burning through a forest at night. | `green forest summer trees` | heldout | visual |
| NM06 | A courtroom with an empty bench and nobody present. | `judge lawyers courtroom hearing` | calibration | absence |
| NM07 | A cargo ship battling a storm at sea. | `cargo ship calm sea` | calibration | visual |
| NM08 | An empty polling station with no voters. | `voters queuing polling station` | heldout | absence |
| NM09 | A smartphone with a shattered, cracked screen. | `smartphone social media feed` | heldout | visual |
| NM10 | A snow-covered city street during a blizzard. | `city street summer sunshine` | calibration | visual |

The reviewer decides whether any candidate fits. If the reviewer marks any candidate relevant in a negative
item, that pair is "contaminated": excluded from negative metrics and counted and listed in the report.
Scenes the reviewer judges "none suitable" are also unsuitable sets (natural negatives) in the detection test.

## 6. Blind human judgments and freezing

What the reviewer sees: `contact-sheet.html` and `review-assets/` only. The sheet, its embedded data and the
image file names carry random opaque item and candidate IDs, the description and the "look for" text; they carry
no item IDs, class words, Pixabay tags, original paths or model output. The mapping back to real IDs is in
`answer-key.json`, which must never be given to the reviewer. Per item the reviewer records: relevant (per
candidate), best (per candidate, ties allowed, subset of relevant), none suitable (per item), optional notes,
reviewer ID. The export (`blind-judgments-<id>.json`, opaque IDs only) records two declarations: labels suggested
by an AI, and saw model scores first. `sawModelScoresFirst = true` is refused at freeze time. AI-suggested labels
are allowed but the report states the judgments are then not fully independent. The freeze script translates the
blind export into the canonical `judgments-<id>.json` using the key (writing it once), validates the files,
records SHA-256 of each canonical judgments file, each blind export, this file, `scenes.json`, `negatives.json`
`candidates.json` and `answer-key.json`, and refuses to overwrite a manifest. It also records, in the manifest
only (never in reviewer-facing files), a SHA-256 of every evaluated image's bytes with the candidate and scene IDs
that use it (`candidateIntegrity`), and refuses to freeze if any image does not equal the hash in `candidates.json`.
The contact-sheet script likewise refuses to build the reviewer sheet from an image that differs from
`candidates.json`. The run script re-verifies all of this before the model run and again before writing
`results.json`; the report re-verifies it and also requires `results.json` to record the same candidate and image
hashes. Filenames and paths are never accepted in place of hashing the bytes, and no hash is ever regenerated to
bless a changed file. A key that no longer matches the items is refused,
never regenerated. The reviewer is not independent of the negatives' author (section 11). The run and report scripts re-verify every hash and reject missing,
changed, malformed or inconsistent files; they never repair them. Judging order: negatives and positives
together in one sheet, before any model run. A second reviewer is optional and kept in a separate file;
the report gives Cohen's kappa over candidate-level relevance labels, or "undefined" with the reason (for
example when one reviewer used a single label throughout), or "not available" without a second reviewer.
The primary reviewer's labels define ground truth.

## 7. Metrics (raw numerators and denominators always shown)

Reporting rule for every rate: raw numerator and denominator, the failures, the exclusions (listed by ID) and the
category denominators are always shown; nothing is dropped silently.

Positive scenes ("eligible" = the primary reviewer marked at least one relevant candidate):
- Top-1 accuracy among eligible scenes. Top-3 accuracy. Best-ranked-first rate (scenes with a human best).
- Pairwise accuracy: over all (relevant, non-relevant) candidate pairs, a win counts 1, a tie 0.5, a pair with an unscored candidate 0.
- Results by category. Pixabay-first baseline: the search-rank-1 candidate is relevant.
- Ties: scores are compared at the worker's 6-decimal rounding. Worst-case tie handling: a tie at the top
  counts as a top-1 success only if every tied top candidate is relevant (likewise for "best").
- Failures: a model-run failure or unscored candidate on an eligible scene counts against the model; it is never excluded.
- Download failures (from candidates.json), decode/inference failures, worker/model-loading fallbacks.
- Latency: median, mean and maximum per call. Load vs inference: timing scenes A02, C03, F03 (calibration
  scenes), 2 calls with 1 image and 2 calls with all 8 candidates each; per-image cost = (mean 8-image ms -
  mean 1-image ms)/7; fixed load = mean 1-image ms - per-image cost.

Calibration and held-out are reported separately. Calibration never substitutes for held-out evidence.

## 8. Decision criteria (held-out results only)

PROMISING: all of the following on the 18 held-out scenes:
1. Top-1 accuracy >= 70% among eligible held-out scenes.
2. Pairwise accuracy >= 75%.
3. Top-1 accuracy at least 15 percentage points above the Pixabay-first baseline on the same scenes.
4. Category coverage criterion: every category must have at least one successful top-1 result among its
   three held-out scenes. The report shows each category's raw successes and denominator. Because each
   category has only three held-out scenes, this is an exploratory coverage safeguard, not strong evidence
   of category-level performance.

NOT PROMISING: any of: top-1 <= 45%; pairwise <= 60%; top-1 no better than the Pixabay-first baseline.

Otherwise INCONCLUSIVE. All comparisons use exact integer arithmetic.

INVALID (structural): a changed hash (including `candidates.json` or any candidate image's bytes, or a missing or inconsistent integrity record), malformed judgments or scores, missing candidates or results, missing
baseline (no search-rank-1 candidate), non-blind judgments, a non-default worker, or a frozen rule that does
not match the calibration data. The report then states the reason and gives no metric-based recommendation.

INCONCLUSIVE (insufficient data): zero eligible held-out scenes, no relevant/non-relevant pairs, or fewer than
12 eligible held-out scenes. The decision order is fixed: a structural problem gives INVALID first (for example
a missing Pixabay-first baseline); only then does a below-minimum eligible sample give INCONCLUSIVE; only then are
the thresholds applied. The minimum of 12 (two thirds of 18) and the calibration floor in section 9 are
PROVISIONAL SAFEGUARDS added in Stage A to cover "insufficient sample". They are not statistically validated
thresholds, are not derived from any power calculation, and do not change the owner's thresholds above. The
report lists every held-out scene excluded as ineligible and every model failure.

## 9. Unsuitable-image detection (separate from ranking quality; not adopted for production)

Unit: an item with a model ranking. "Suitable" = eligible positive scene. "Unsuitable" = positive scene
judged none-suitable, plus valid cross-category and near-miss items. Reporting groups, always shown separately
with designed and evaluated counts: cross-category (gross-mismatch sanity check), ordinary near-miss, absence /
negation near-miss, and naturally none-suitable scenes. The held-out detection result (AUROC, false
rejection, false acceptance) is INCLUSIVE: it covers every eligible held-out item, absence/negation items
included, and no difficult case is dropped. The groups above are diagnostic subgroups shown beside it, each with
its own denominators and AUROC against the held-out suitable sets; the report may also print a clearly labelled
diagnostic figure with absence items left out, which never replaces the inclusive result. The cross-category
items remain a gross-mismatch sanity check and are never presented as fine-grained discrimination. Contaminated and model-failed items are excluded from the metrics but counted and listed per group. Statistics per item: top score; top-1
minus top-2 gap; top-1 minus median of the item's scores.

Selection, on CALIBRATION items only (the floor of 3 per class and the AUROC floor of 0.70 are provisional
safeguards, not validated thresholds): need >= 3 suitable and >= 3 unsuitable calibration items; compute AUROC
(ties 0.5) for each statistic; take the highest (ties: the order listed above); if its AUROC is < 0.70, no
usable rule is established and none is invented. Otherwise one threshold: candidate thresholds are midpoints
between adjacent distinct values; choose the one maximising balanced accuracy on calibration; ties go to
the larger threshold. A set is "accepted" when statistic >= threshold. The rule is written to
`frozen-rule.json` (bound to the results and manifest hashes) before the held-out evaluation; the report
recomputes it and rejects any mismatch. Held-out: AUROC, false rejection (suitable set rejected) and false
acceptance (unsuitable set accepted) with counts, broken down by negative kind. These do not affect the verdict.

Caution: cosine similarity depends on the exact text prompt, so a threshold may not transfer to other
scenes or prompt wording. Nothing here changes production behaviour.

## 10. Safe offline vs network/model scripts

| Script | Offline | Needs later |
|---|---|---|
| `eval-scene-relevance-v2-lib.js`, `-contact-sheet.js`, `-freeze.js`, `-report.js`, tests | yes | none |
| `eval-scene-relevance-v2-fetch.js` | `--dry-run` only | Pixabay key, network, `--confirm-stage-approved` |
| `eval-scene-relevance-v2-evidence.js` (`record`, `verify`) | yes | none (needs a completed freeze) |
| `eval-scene-relevance-v2-run.js` | no | local model folder (`SCENE_RELEVANCE_MODEL_DIR`) and frozen judgments |

## 11. Limitations

30 scenes, 18 held-out, 3 per category; one search per scene and fixed spaced positions; candidates are
Pixabay photos, not the engine's real content mix; judgments are by one person (possibly AI-assisted);
the evaluation is NOT fully blind: each cross-category description repeats a positive scene's text word for word
and reuses that scene's photo set (a photo set can appear under several items); near-miss descriptions have a
recognisable "empty or damaged" style; the visual conditions themselves are recognisable; image metadata is not
stripped; and the negatives' author, who knows which items are negatives, cannot be an independent blind reviewer;
the tool records but cannot prove that judging preceded score viewing; the worker squashes images to
224x224 (documented, unchanged); no other model was compared.

## 12. Licensing gate (unresolved)

Exact artifact: `Xenova/siglip-base-patch16-224` ONNX conversion at revision
`4649052661e53c7000355844105f8a1792088239`; `onnx/text_model_quantized.onnx` SHA-256
`AD0329B1F35ACC66D8953FF2559CE358DA8EB0A7011794CF951523D63A4DBCE2`, `onnx/vision_model_quantized.onnx`
SHA-256 `EF14A954F3D57E1806666432BD9785004C1DC27100AA260EEE0CB0F10A5DE058` (from THIRD_PARTY_NOTICES.md),
from Hugging Face; base model `google/siglip-base-patch16-224` declares Apache-2.0. The conversion declares
no licence. Evidence still needed before any production or commercial use: a licence statement from the
conversion's author, or a self-conversion from the Apache-2.0 base weights with documented provenance, plus
the owner's recorded decision. This evaluation does not clear the model for production or commercial use.

## 13. Freeze lifecycle and model identity (pre-freeze addendum; behaviour of the tooling, not a change to criteria)

Once `judgments-manifest.json` (or any freeze-era or review artefact) exists, the fetch script refuses to run and nothing is
removed or replaced; a new evaluation uses a separate folder and preregistration. Before inference the run script verifies the
bytes of the two pinned ONNX files named in section 12 against those SHA-256 values, again before every call and after the run;
the report accepts a result only if that verified identity is recorded. No threshold, scene, split or negative case changes.
The tokenizer, config and preprocessor files are not hash-pinned (the repository records no hashes for them).
The recovery procedure is in `FREEZE-EVIDENCE.md`.
