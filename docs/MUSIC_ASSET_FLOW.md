# Local rights-verified music asset flow

The engine never searches, scrapes, downloads, or bundles music. The owner supplies a local audio file and the complete licence text, then records it as an attached `asset_type = 'music'` asset before Media Production.

1. Keep the original audio file in an owner-controlled local path. Calculate and retain its SHA-256.
2. Keep the full licence text with the project records. Record that text in the asset's `license` field; do not substitute a URL or a paraphrase.
3. Record the asset's actual local path, checksum, source/origin, required attribution and usage restrictions in the existing asset provenance record, then attach it to the intended `content_version` using the existing `asset_usages` relation. Use `asset_type: 'music'`.
4. Complete the existing Rights Verification process. The music asset must be `VERIFIED`; `UNVERIFIED` and `DISPUTED` assets block Media Production before any mixing occurs.
5. Run Media Production. It deterministically selects the lowest-ID attached music asset, loops/fades it, ducks it beneath narration, and applies the final loudness normalization last.

No licence text, checksum, or verification record means no music asset is eligible for use. The owner must review the resulting video by ear; automated QA only measures loudness and reports evidence-only warnings.
