# Catalog product import

Knowledge activation can turn a supported catalog document into canonical Lulu
product data. It is a product-master workflow, not a flexible-record import.

## Durable flow

```text
catalog document(s)
  -> durable catalog.import job with lease, heartbeat and bounded retries
  -> page text + scanned-page/product-image extraction into catalog_import_evidence
  -> grounded product-family, variant and evidence-ID proposal
  -> customer review (REVIEW_REQUIRED); no product is created yet
  -> confirmed products + product_variants + specifications (all DRAFT)
  -> copy mapped evidence image into canonical product_media for its exact variant
  -> reference-grounded premium media job per variant
```

Only purchasable configurations supported by the source become variants. A
color-by-size matrix is expanded only when the catalog establishes that every
combination is available. Product and variant typed fields include SKU,
barcode, price, weight, dimensions, MOQ and lead time where the source proves
them. The evidence record retains the source document, page and extracted image
asset; `source_document_id` is foreign-keyed to the onboarding document with
`ON DELETE SET NULL`, so document cleanup cannot silently orphan a reference
without preserving the evidence row. Source document identifiers, structured
attributes and evidence IDs are retained in variant metadata for later review.

Text PDFs are read page by page. For scanned PDFs, Lulu extracts decoded PDF
image assets and runs the existing vision/OCR path over them. A source image is
not automatically treated as a product image: the classifier must link its
evidence ID to the specific product or variant, and the customer must confirm
the proposal before the image becomes canonical product media.

Reference uploads must be JPEG, PNG, or WebP. They are copied from temporary
onboarding storage into the product reference namespace before any premium
media work begins. The copied reference establishes invariant visual identity;
the generation brief may change only the documented variant attributes such as
color, length, or size.

Catalog products and variants are initially `DRAFT`. Premium media remains
tenant-scoped, prepaid, quality-gated, and retry-safe. If AI funds are not
available during activation, the premium-media worker revisits variant targets
after a workspace funding event; no variant is silently collapsed into a
product-family image.
