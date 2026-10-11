# Preregistration: SigLIP scene-relevance evaluation v2

Status: FROZEN at Stage A, before any image is fetched and before any model score exists.
The SHA-256 of this file, `scenes.json` and `negatives.json` is recorded in `judgments-manifest.json`
when judgments are frozen, and the run and report scripts refuse to proceed if any of them changed.
Nothing below may be changed after seeing scores. Evaluation authorisation here is separate from
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

Why stratified: a pure global "lowest 15 hashes" split leaves category C with no held-out scenes, which
would make a per-category criterion impossible. The owner approved the stratified split.

## 5. Negative sets (unsuitable-image detection)

Mixed into the same blind sheet as the positive scenes (50 items, opaque order J01-J50, shuffled by
SHA-256), so the reviewer cannot tell which are negatives and sees no model output.

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

| Item | Description | Query | Split |
|---|---|---|---|
| NM01 | Drought-damaged maize wilting in a cracked, dry field. | `green healthy maize field` | calibration |
| NM02 | Empty supermarket shelves after panic buying. | `fully stocked supermarket shelves` | heldout |
| NM03 | A flooded street with water up to the car windows. | `dry city street sunny day` | calibration |
| NM04 | An empty operating theatre with no staff or patient. | `surgeons operating theatre team` | heldout |
| NM05 | A wildfire burning through a forest at night. | `green forest summer trees` | calibration |
| NM06 | A courtroom with an empty bench and nobody present. | `judge lawyers courtroom hearing` | heldout |
| NM07 | A cargo ship battling a storm at sea. | `cargo ship calm sea` | calibration |
| NM08 | An empty polling station with no voters. | `voters queuing polling station` | heldout |
| NM09 | A smartphone with a shattered, cracked screen. | `smartphone social media feed` | calibration |
| NM10 | A snow-covered city street during a blizzard. | `city street summer sunshine` | heldout |

The reviewer decides whether any candidate fits. If the reviewer marks any candidate relevant in a negative
item, that pair is "contaminated": excluded from negative metrics and counted and listed in the report.
Scenes the reviewer judges "none suitable" are also unsuitable sets (natural negatives) in the detection test.

## 6. Blind human judgments and freezing

Per item: relevant (per candidate), best (per candidate, ties allowed, subset of relevant), none suitable
(per item), optional notes, reviewer ID. The export records two declarations: labels suggested by an AI,
and saw model scores first. `sawModelScoresFirst = true` is refused at freeze time. AI-suggested labels are
allowed but the report states the judgments are then not fully independent. The freeze script validates
the files, records SHA-256 of each judgments file and of this file, `scenes.json` and `negatives.json`, and
refuses to overwrite a manifest. The run and report scripts re-verify every hash and reject missing,
changed, malformed or inconsistent files; they never repair them. Judging order: negatives and positives
together in one sheet, before any model run. A second reviewer is optional and kept in a separate file;
the report gives Cohen's kappa over candidate-level relevance labels, or "undefined" with the reason (for
example when one reviewer used a single label throughout), or "not available" without a second reviewer.
The primary reviewer's labels define ground truth.

## 7. Metrics (raw numerators and denominators always shown)

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

INVALID (structural): a changed hash, malformed judgments or scores, missing candidates or results, missing
baseline (no search-rank-1 candidate), non-blind judgments, a non-default worker, or a frozen rule that does
not match the calibration data. The report then states the reason and gives no metric-based recommendation.

INCONCLUSIVE (insufficient data): zero eligible held-out scenes, no relevant/non-relevant pairs, or fewer than
12 eligible held-out scenes. The minimum of 12 (two thirds of 18) and the calibration floor in section 9 were
added in Stage A to cover "insufficient sample" and are flagged for owner approval; they do not change the
owner's thresholds above.

## 9. Unsuitable-image detection (separate from ranking quality; not adopted for production)

Unit: an item with a model ranking. "Suitable" = eligible positive scene. "Unsuitable" = positive scene
judged none-suitable, plus valid cross-category and near-miss items. Statistics per item: top score; top-1
minus top-2 gap; top-1 minus median of the item's scores.

Selection, on CALIBRATION items only: need >= 3 suitable and >= 3 unsuitable calibration items; compute AUROC
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
| `eval-scene-relevance-v2-run.js` | no | local model folder (`SCENE_RELEVANCE_MODEL_DIR`) and frozen judgments |

## 11. Limitations

30 scenes, 18 held-out, 3 per category; one search per scene and fixed spaced positions; candidates are
Pixabay photos, not the engine's real content mix; judgments are by one person (possibly AI-assisted);
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
