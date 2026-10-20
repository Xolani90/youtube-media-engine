# SigLIP scene-relevance evaluation report

Run: 2026-10-11T08:42:21.912Z | repo HEAD: 34e02a72fbc2b5369f45b8fc3b7ed22816738086 | node v22.16.0 on win32 | model dir: siglip-base-patch16-224 | dtype: q8 (worker default)

## Recommendation: PROMISING

Basis: top-1 relevant 8/10 (80%) and pairwise accuracy 89% meet the pre-set thresholds (>= 70% / >= 75%).

Rule fixed before the data existed: PROMISING needs >= 8 usable scenes, top-1 >= 70% and pairwise accuracy >= 75%; NOT PROMISING if top-1 <= 40% or pairwise <= 55%; otherwise INCONCLUSIVE. This is a heuristic on a small sample, not statistical proof of general performance.

## Counts

- Scenes evaluated (human-reviewed and ranked): 10 of 10
- Candidate images scored: 50 of 50
- Top-1 relevant: 8/10 (80%) (among the 9 scenes with any relevant candidate: 8/9 (89%))
- Top-3 relevant: 9/9 (100%) (weak signal with ~5 candidates per scene)
- Best human-judged candidate ranked first: 4/6 (67%)
- Obvious ranking failures (a relevant candidate existed, top-1 was not relevant): 1 (S02)
- Top-1 relevant but a clearly better candidate existed: 2 (S06, S10)
- Scenes where no candidate was suitable: 1
- Pairwise accuracy (relevant scored above non-relevant, ties 0.5): 41/46 (89%)
- Preprocessing/decode failures: 0
- Ranking (worker) failures: 0

Reference points from the same data (not a comparison with another model):
- Expected top-1 if the order were random: 42%
- Top-1 if the first candidate (Pixabay search rank order within the sampled set) were taken: 5/9 (56%)

## Per scene

| Scene | Human relevant | Human best | SigLIP top | Top relevant | Ranking (score) | Notes |
|---|---|---|---|---|---|---|
| S01 | none suitable | - | B | no | B 0.0458 > D 0.0440 > A 0.0044 > E -0.0232 > C -0.0370 | all illustrations or graphics, no trading floor |
| S02 | B | - | C | no | C 0.0895 > B 0.0884 > E 0.0817 > A 0.0801 > D 0.0172 | B = cleaning, not installing. A = worker posing on rooftop. C = aerial farm, no people. D, E = illustrations. Labels suggested by Claude, confirmed by me. |
| S03 | A,B,C,D | A,C | C | yes | C 0.1078 > A 0.0978 > E 0.0859 > B 0.0795 > D 0.0696 | A-D = port cranes + containers; A and C show crane beside ship (best). E = inland canal, no ship. No image shows loading in progress. Labels suggested by Claude, confirmed by me. |
| S04 | B | - | B | yes | B 0.1066 > D 0.0293 > A 0.0284 > C -0.0047 > E -0.0049 | B = hard-hatted workers posing in factory, not inspecting (closest). D = posed engineer portrait, no hard hat, left out. A, C, E = machinery, nobody near it. No image shows inspection. Labels suggested by Claude, confirmed by me. |
| S05 | A | - | A | yes | A 0.1244 > E 0.0470 > B 0.0353 > C 0.0259 > D 0.0087 | A = farmer in dry golden field, looks like harvest, drought damage not clearly visible (closest). B = healthy wheat close-up. C = green field with sprayer. D = passion fruit in hands. E = wet ground. Labels suggested by Claude, confirmed by me. |
| S06 | A,B,E | E | A | yes | A 0.0745 > E 0.0738 > B 0.0646 > C 0.0373 > D -0.0770 | E = corridor of cabinets in rows, but tags say electrical cabinet so could be switchgear (best, uncertain). A = hand in single rack, B = close-up of server hardware. C = 3D render. D = dog. Labels suggested by Claude, confirmed by me. |
| S07 | B,D | D,B | B | yes | B 0.1075 > E 0.0807 > D 0.0763 > C 0.0160 > A -0.0249 | D = aerial NYC street packed with cabs (best). B = aerial interchange, traffic moderate. A = skyline, no visible traffic. C = night skyline. E = ground-level queue, real congestion but not aerial. Labels suggested by Claude, confirmed by me. |
| S08 | A,D,E | E | E | yes | E 0.0841 > A 0.0575 > D 0.0568 > B 0.0100 > C -0.0261 | E = technician examining a flask in lab (best), looks stylised/possibly rendered. A, D = hands handling sample tubes. B = pipette tips, C = sample cups, no person. No image shows a microscope. Labels suggested by Claude, confirmed by me. |
| S09 | B,A | B | B | yes | B 0.0877 > E 0.0825 > A 0.0748 > C 0.0641 > D 0.0094 | B = cartons on roller conveyor (best), close-up, no warehouse context. A = conveyor curve in industrial hall, no parcels. C = overhead conveyor in factory, borderline, left out. D = bottling line. E = static shelving. Labels suggested by Claude, confirmed by me. |
| S10 | C,E | E | C | yes | C 0.1016 > E 0.0998 > D 0.0893 > B 0.0708 > A 0.0556 | E = substation gantry structure and equipment (best). C = rows of transformer-type equipment, tight crop. A = single pylon, excluded by target. B = insulator close-up, left out. D = power station, left out. Labels suggested by Claude, confirmed by me. |

## Latency

- Calls: 10; mean 14774 ms; median 12406 ms; min 11284 ms; max 24564 ms; total 147.7 s
- Calibration on S01: 1-image calls 4847, 4821 ms; 5-image calls 11704, 12972 ms
- Estimated fixed load cost per call: ~2958 ms; estimated cost per additional image: ~1876 ms
- Identical ranking across the two repeated full calls: yes
- Fixed load is about 24% of a 5-image call. If scenes were batched into one worker call, 10 scenes would pay the load once instead of 10 times: rough saving ~27 s for this workload (an estimate; batching is NOT implemented and needs a separate authorized task).

## Limitations

- Small exploratory sample: 10 scenes, ~5 candidates each, one human judge. Percentages are not statistical proof of general performance.
- Candidates are sampled from spaced positions of one Pixabay search per scene (see candidatePickRule in scenes.json); how hard the test is depends on that choice.
- Scenes are the owner-supplied starting examples, not a measured sample of the engine's real content mix.
- Judgments were made by a person looking at the contact sheet; confirm the judgments were completed before the scores were viewed (the tooling cannot prove this).
- Preprocessing used by the worker: {"do_normalize":true,"do_rescale":true,"do_resize":true,"image_processor_type":"SiglipImageProcessor","image_mean":[0.5,0.5,0.5],"processor_class":"SiglipProcessor","resample":3,"rescale_factor":0.00392156862745098,"size":{"height":224,"width":224},"image_std":[0.5,0.5,0.5]}. Check whether it resizes to a square (which would distort wide photos); the evaluation did not alter it.
- No comparison with any other model was run, so nothing here shows SigLIP is better than an alternative.

## Unresolved licensing and operational concerns

- The Xenova ONNX conversion still declares no license; the decision in THIRD_PARTY_NOTICES.md remains "pending owner decision". This evaluation does not resolve it.
- Pixabay availability does not by itself settle downstream rights. Candidate photos are for this evaluation only: do not commit or redistribute eval/scene-relevance/images/, and recognisable people, brands or logos may carry extra restrictions. Provenance is recorded in candidates.json.
- Pixabay terms require caching results and disallow systematic bulk downloading; this run used one search per scene and ~5 downloads each. Do not re-run needlessly.
- The worker reloads all models on every call and is not wired into the pipeline; per-call cost above is the current operational baseline.
- Model files were downloaded from `resolve/main` and pinned only after the fact in the notice; setup instructions should use the pinned revision.
- Scores rank candidates; they are not a rights, factual or safety check.
