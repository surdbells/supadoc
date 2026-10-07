# RxNorm prescribable catalogue

`rxnorm-prescribable.tsv.gz` is the drug catalogue behind e-prescribing: every
prescribable product (RxNorm term types SCD, SBD, GPCK, BPCK; not suppressed)
from the **RxNorm Current Prescribable Content** release of **5 October 2026**
(`RxNorm_full_prescribe_10052026.zip`) — 21,514 products.

Columns (tab-separated, header row): `rxcui`, `tty`, `name` (full RxNorm name),
`psn` (prescribable name), `brand`, `dose_form`, `route` (derived), `synonyms`
(`|`-separated).

- Load into the database: `php bin/import-rxnorm.php`
- Refresh from a newer monthly release:
  `php bin/build-rxnorm-dataset.php /path/to/RxNorm_full_prescribe_MMDDYYYY.zip`,
  commit the regenerated file, then re-run the import on each environment.

## Attribution

This product uses publicly available data courtesy of the U.S. National Library
of Medicine (NLM), National Institutes of Health, Department of Health and Human
Services; NLM is not responsible for the product and does not endorse or
recommend this or any other product. RxNorm Current Prescribable Content is
available without a UMLS licence; the RxNorm-sourced (SAB=RXNORM) content used
here is in the public domain. Source: https://www.nlm.nih.gov/research/umls/rxnorm/
