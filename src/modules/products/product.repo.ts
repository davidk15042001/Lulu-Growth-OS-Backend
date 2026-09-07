import { query, withTransaction } from '../../db/pool.js';
import { buildUpdateSet } from '../../db/update-builder.js';
import { appendDomainEvent } from '../../events/domain-event.repo.js';
import { DOMAIN_EVENT_TYPES } from '../../events/domain-event.types.js';
import type { CreateProductInput, UpdateProductInput, ListProductsQuery } from './product.validator.js';

export type Product = Record<string, unknown> & { id: string; workspaceId: string; name: string; version: number };
export type ProductDetail = Product & { variants: unknown[]; specifications: unknown[]; media: unknown[]; certificates: unknown[]; packaging: unknown[]; capacity: unknown[]; prices: unknown[]; markets: unknown[]; translations: unknown[]; seo: unknown[]; applications: unknown[]; relationships: unknown[]; completeness: ProductCompleteness };
export type ProductCompleteness = { score: number; missing: string[]; readyForPublishing: boolean };

const productSelect = `p.id, p.workspace_id AS "workspaceId", p.factory_id AS "factoryId", p.brand_id AS "brandId", p.category_id AS "categoryId", p.status, p.product_type AS "productType", p.sku, p.internal_code AS "internalCode", p.name, p.short_description AS "shortDescription", p.long_description AS "longDescription", p.default_currency AS "defaultCurrency", p.default_price AS "defaultPrice", p.pricing_type AS "pricingType", p.moq_quantity AS "moqQuantity", p.moq_unit AS "moqUnit", p.lead_time_min_days AS "leadTimeMinDays", p.lead_time_max_days AS "leadTimeMaxDays", p.production_capacity_value AS "productionCapacityValue", p.production_capacity_unit AS "productionCapacityUnit", p.production_capacity_period AS "productionCapacityPeriod", p.country_of_origin AS "countryOfOrigin", p.hs_code AS "hsCode", p.visibility, p.source_language AS "sourceLanguage", p.version, p.legacy_source_type AS "legacySourceType", p.legacy_source_id AS "legacySourceId", p.created_by AS "createdBy", p.updated_by AS "updatedBy", p.created_at AS "createdAt", p.updated_at AS "updatedAt"`;

function completeness(product: Product, nested: Record<string, unknown[]>): ProductCompleteness {
  const checks: Array<[string, boolean]> = [
    ['name', Boolean(product.name)], ['description', Boolean(product.shortDescription || product.longDescription)],
    ['pricing', Boolean(product.defaultPrice || product.pricingType === 'QUOTE_REQUIRED' || nested.prices?.length)],
    ['moq', Boolean(product.moqQuantity || nested.variants?.some((v: any) => v.moqQuantity))],
    ['leadTime', product.leadTimeMinDays != null || product.leadTimeMaxDays != null],
    ['media', Boolean(nested.media?.length)], ['translation', Boolean(nested.translations?.length)],
    ['market', Boolean(nested.markets?.length)], ['specifications', Boolean(nested.specifications?.length)],
  ];
  const missing = checks.filter(([, ok]) => !ok).map(([key]) => key);
  return { score: Math.round(((checks.length - missing.length) / checks.length) * 100), missing, readyForPublishing: missing.length === 0 && product.status !== 'ARCHIVED' };
}

export async function listProducts(workspaceId: string, filters: ListProductsQuery) {
  const values: unknown[] = [workspaceId];
  const conditions = ['p.workspace_id = $1', 'p.deleted_at IS NULL'];
  if (filters.search) { values.push(`%${filters.search}%`); conditions.push(`(p.name ILIKE $${values.length} OR p.sku ILIKE $${values.length} OR p.internal_code ILIKE $${values.length})`); }
  if (filters.status) { values.push(filters.status); conditions.push(`p.status = $${values.length}`); }
  if (filters.productType) { values.push(filters.productType); conditions.push(`p.product_type = $${values.length}`); }
  if (filters.categoryId) { values.push(filters.categoryId); conditions.push(`p.category_id = $${values.length}`); }
  const sortMap: Record<string, string> = { name: 'p.name', createdAt: 'p.created_at', updatedAt: 'p.updated_at', status: 'p.status' };
  const order = filters.order === 'asc' ? 'ASC' : 'DESC';
  const offset = (filters.page - 1) * filters.limit;
  const [items, count] = await Promise.all([
    query<Product>(`SELECT ${productSelect} FROM products p WHERE ${conditions.join(' AND ')} ORDER BY ${sortMap[filters.sort] ?? 'p.updated_at'} ${order}, p.id ${order} LIMIT $${values.length + 1} OFFSET $${values.length + 2}`, [...values, filters.limit, offset]),
    query<{ total: string }>(`SELECT count(*)::text AS total FROM products p WHERE ${conditions.join(' AND ')}`, values),
  ]);
  return { items: items.rows.map((p) => ({ ...p, completeness: completeness(p, {}) })), pagination: { page: filters.page, limit: filters.limit, total: Number(count.rows[0]?.total ?? 0), totalPages: Math.ceil(Number(count.rows[0]?.total ?? 0) / filters.limit) } };
}

export async function findProduct(workspaceId: string, productId: string) {
  const { rows } = await query<Product>(`SELECT ${productSelect} FROM products p WHERE p.workspace_id=$1 AND p.id=$2 AND p.deleted_at IS NULL LIMIT 1`, [workspaceId, productId]);
  return rows[0];
}

export async function getProductDetail(workspaceId: string, productId: string): Promise<ProductDetail | undefined> {
  const product = await findProduct(workspaceId, productId); if (!product) return undefined;
  const tables: Record<string, string> = { variants: 'product_variants', specifications: 'product_specifications', media: 'product_media', certificates: 'product_certificates', packaging: 'product_packaging', capacity: 'product_capacity', prices: 'product_prices', markets: 'product_market_data', translations: 'product_translations', seo: 'product_seo_metadata', applications: 'product_applications' };
  const nestedEntries = await Promise.all(Object.entries(tables).map(async ([key, table]) => {
    const { rows } = await query(`SELECT * FROM ${table} WHERE workspace_id=$1 AND product_id=$2 ORDER BY created_at ASC, id ASC`, [workspaceId, productId]);
    return [key, rows] as const;
  }));
  const { rows: relationships } = await query(`SELECT * FROM product_relationships WHERE workspace_id=$1 AND (source_product_id=$2 OR target_product_id=$2) ORDER BY created_at ASC`, [workspaceId, productId]);
  const nested = Object.fromEntries(nestedEntries) as Record<string, unknown[]>; nested.relationships = relationships;
  return { ...product, ...nested, completeness: completeness(product, nested) } as ProductDetail;
}

export async function createProduct(workspaceId: string, userId: string, input: CreateProductInput) {
  return withTransaction(async (client) => {
    const { rows } = await query<{ id: string }>(`INSERT INTO products (workspace_id,factory_id,brand_id,category_id,status,product_type,sku,internal_code,name,short_description,long_description,default_currency,default_price,pricing_type,moq_quantity,moq_unit,lead_time_min_days,lead_time_max_days,production_capacity_value,production_capacity_unit,production_capacity_period,country_of_origin,hs_code,visibility,source_language,created_by,updated_by) VALUES ($1,$2,$3,$4,COALESCE($5,'DRAFT'),COALESCE($6,'PHYSICAL_PRODUCT'),$7,$8,$9,$10,$11,$12,$13,COALESCE($14,'QUOTE_REQUIRED'),$15,$16,$17,$18,$19,$20,$21,$22,$23,COALESCE($24,'PRIVATE'),COALESCE($25,'en'),$26,$26) RETURNING id`, [workspaceId,input.factoryId??null,input.brandId??null,input.categoryId??null,input.status??null,input.productType??null,input.sku??null,input.internalCode??null,input.name,input.shortDescription??null,input.longDescription??null,input.defaultCurrency??null,input.defaultPrice??null,input.pricingType??null,input.moqQuantity??null,input.moqUnit??null,input.leadTimeMinDays??null,input.leadTimeMaxDays??null,input.productionCapacityValue??null,input.productionCapacityUnit??null,input.productionCapacityPeriod??null,input.countryOfOrigin??null,input.hsCode??null,input.visibility??null,input.sourceLanguage??null,userId], client);
    const id = rows[0]?.id; if (!id) throw new Error('Product insert did not return an id');
    await query(`INSERT INTO audit_log (workspace_id,actor_id,action,entity_type,entity_id,after_data) VALUES ($1,$2,'product.created','product',$3,$4)`, [workspaceId,userId,id,input], client);
    await appendDomainEvent({ workspaceId, type: DOMAIN_EVENT_TYPES.PRODUCT_CREATED, aggregateType: 'product', aggregateId: id, payload: { productId: id, name: input.name }, metadata: { actorId: userId, source: 'products' }, idempotencyKey: `product:${id}:created:v1` }, client);
    return id;
  });
}

const updateColumns: Partial<Record<keyof UpdateProductInput, string>> = { factoryId:'factory_id',brandId:'brand_id',categoryId:'category_id',status:'status',productType:'product_type',sku:'sku',internalCode:'internal_code',name:'name',shortDescription:'short_description',longDescription:'long_description',defaultCurrency:'default_currency',defaultPrice:'default_price',pricingType:'pricing_type',moqQuantity:'moq_quantity',moqUnit:'moq_unit',leadTimeMinDays:'lead_time_min_days',leadTimeMaxDays:'lead_time_max_days',productionCapacityValue:'production_capacity_value',productionCapacityUnit:'production_capacity_unit',productionCapacityPeriod:'production_capacity_period',countryOfOrigin:'country_of_origin',hsCode:'hs_code',visibility:'visibility',sourceLanguage:'source_language' };
export async function updateProduct(workspaceId: string, productId: string, userId: string, input: UpdateProductInput) {
  const { expectedVersion, ...changes } = input; const update = buildUpdateSet({ ...changes, updatedBy: userId, version: undefined } as any, { ...updateColumns, updatedBy:'updated_by' } as any, 3); const assignments = [...update.assignments, 'version = version + 1'];
  return withTransaction(async (client) => {
    const params = [workspaceId, productId, ...(update.values as unknown[]), expectedVersion ?? null];
    const { rowCount } = await query(`UPDATE products SET ${assignments.join(', ')} WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL AND ($${params.length}::int IS NULL OR version=$${params.length})`, params, client);
    if (rowCount === 0) return false;
    await query(`INSERT INTO audit_log (workspace_id,actor_id,action,entity_type,entity_id,after_data) VALUES ($1,$2,'product.updated','product',$3,$4)`, [workspaceId,userId,productId,changes], client);
    await appendDomainEvent({ workspaceId, type: DOMAIN_EVENT_TYPES.PRODUCT_UPDATED, aggregateType:'product', aggregateId: productId, payload:{ productId, changedFields:Object.keys(changes) }, metadata:{ actorId:userId, source:'products' } }, client);
    if ((changes as any).status === 'ACTIVE') await appendDomainEvent({ workspaceId, type: DOMAIN_EVENT_TYPES.PRODUCT_ACTIVATED, aggregateType:'product', aggregateId: productId, payload:{ productId }, metadata:{ actorId:userId, source:'products' } }, client);
    return true;
  });
}
export async function archiveProduct(workspaceId: string, productId: string, userId: string) { return withTransaction(async (client) => { const { rowCount } = await query(`UPDATE products SET status='ARCHIVED', deleted_at=NOW(), updated_by=$3 WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL`, [workspaceId,productId,userId], client); if (rowCount) await appendDomainEvent({workspaceId,type:DOMAIN_EVENT_TYPES.PRODUCT_ARCHIVED,aggregateType:'product',aggregateId:productId,payload:{productId},metadata:{actorId:userId,source:'products'},idempotencyKey:`product:${productId}:archived:v1`},client); return rowCount > 0; }); }

const childTables = {
  variants: { table:'product_variants', event:DOMAIN_EVENT_TYPES.PRODUCT_VARIANT_CREATED, columns:['name','sku','status','barcode','weight','weight_unit','dimension_length','dimension_width','dimension_height','dimension_unit','default_price','default_currency','moq_quantity','moq_unit','lead_time_min_days','lead_time_max_days','metadata'], fields:['name','sku','status','barcode','weight','weightUnit','dimensionLength','dimensionWidth','dimensionHeight','dimensionUnit','defaultPrice','defaultCurrency','moqQuantity','moqUnit','leadTimeMinDays','leadTimeMaxDays','metadata'] },
  specifications: { table:'product_specifications', event:null, columns:['variant_id','name','value','unit','group_name','sort_order','market_visibility','key'], fields:['variantId','name','value','unit','groupName','sortOrder','marketVisibility','key'] },
  media: { table:'product_media', event:DOMAIN_EVENT_TYPES.PRODUCT_MEDIA_ADDED, columns:['variant_id','media_type','storage_reference','external_url','title','alt_text','sort_order','is_primary','language'], fields:['variantId','mediaType','storageReference','externalUrl','title','altText','sortOrder','isPrimary','language'] },
  certificates: { table:'product_certificates', event:DOMAIN_EVENT_TYPES.PRODUCT_CERTIFICATE_ADDED, columns:['certificate_type','certificate_number','issuing_body','issued_at','expires_at','document_media_id','verification_status','notes'], fields:['certificateType','certificateNumber','issuer','issuedAt','expiresAt','documentMediaId','status','notes'] },
  markets: { table:'product_market_data', event:DOMAIN_EVENT_TYPES.PRODUCT_MARKET_ENABLED, columns:['market_code','localized_name','localized_description','market_price','currency','moq_quantity','moq_unit','lead_time_min_days','lead_time_max_days','compliance_notes','availability','sales_priority','status'], fields:['marketCode','marketName','localizedDescription','marketPrice','currency','moqQuantity','moqUnit','leadTimeDays','leadTimeDays','notes','availability','salesPriority','status'] },
  translations: { table:'product_translations', event:DOMAIN_EVENT_TYPES.PRODUCT_TRANSLATION_CREATED, columns:['language','name','short_description','long_description','seo_title','seo_description','status','source'], fields:['language','name','shortDescription','longDescription','seoTitle','seoDescription','status','source'] },
  applications: { table:'product_applications', event:null, columns:['name','description','sort_order'], fields:['application','notes','sortOrder'] },
  packaging: { table:'product_packaging', event:null, columns:['packaging_type','units_per_package','package_length','package_width','package_height','package_weight','dimension_unit','weight_unit','notes'], fields:['packageType','quantity','length','width','height','grossWeight','dimensionUnit','weightUnit','notes'] },
  capacity: { table:'product_capacity', event:null, columns:['variant_id','value','unit','period','notes'], fields:['variantId','value','unit','period','notes'] },
  prices: { table:'product_prices', event:null, columns:['variant_id','market_code','currency','amount','min_quantity','max_quantity','pricing_type','valid_from','valid_until','status'], fields:['variantId','marketCode','currency','unitPrice','minQuantity','maxQuantity','priceType','validFrom','validUntil','status'] },
  seo: { table:'product_seo_metadata', event:null, columns:['language','seo_title','meta_description','canonical_name','keywords','faq_candidates','buyer_questions','applications','search_intent','source','status'], fields:['language','title','description','slug','keywords','structuredData','keywords','keywords','searchIntent','source','status'] },
} as const;
export type ChildKey = keyof typeof childTables;

export async function listChildren(workspaceId: string, productId: string, key: ChildKey) { const cfg = childTables[key]; const { rows } = await query(`SELECT * FROM ${cfg.table} WHERE workspace_id=$1 AND product_id=$2 ORDER BY created_at ASC,id ASC`,[workspaceId,productId]); return rows; }
export async function createChild(workspaceId: string, productId: string, userId: string, key: ChildKey, input: Record<string, unknown>) { const cfg = childTables[key]; return withTransaction(async (client) => { const columns = ['workspace_id','product_id',...cfg.columns]; const values = [workspaceId,productId,...cfg.fields.map((field) => input[field] ?? null)]; const placeholders = values.map((_,i)=>`$${i+1}`).join(','); const { rows } = await query<{id:string}>(`INSERT INTO ${cfg.table} (${columns.join(',')}) VALUES (${placeholders}) RETURNING id`,values,client); const id=rows[0]?.id; if (!id) throw new Error('Child insert did not return an id'); if (cfg.event) await appendDomainEvent({workspaceId,type:cfg.event,aggregateType:'product',aggregateId:productId,payload:{productId,childType:key,childId:id},metadata:{actorId:userId,source:'products'}},client); return id; }); }
export async function deleteChild(workspaceId: string, productId: string, key: ChildKey, childId: string) { const { rowCount } = await query(`DELETE FROM ${childTables[key].table} WHERE workspace_id=$1 AND product_id=$2 AND id=$3`,[workspaceId,productId,childId]); return rowCount > 0; }

export async function createRelationship(workspaceId: string, productId: string, userId: string, input: { relatedProductId: string; relationshipType: string; notes?: string | null | undefined }) {
  return withTransaction(async (client) => {
    const target = await query<{ id: string }>('SELECT id FROM products WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL', [workspaceId, input.relatedProductId], client);
    if (!target.rows[0]) return undefined;
    const { rows } = await query<{ id: string }>(`INSERT INTO product_relationships (workspace_id,source_product_id,target_product_id,relationship_type,notes) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [workspaceId, productId, input.relatedProductId, input.relationshipType, input.notes ?? null], client);
    const id = rows[0]?.id;
    if (id) await appendDomainEvent({ workspaceId, type: DOMAIN_EVENT_TYPES.PRODUCT_UPDATED, aggregateType: 'product', aggregateId: productId, payload: { productId, relationshipId: id }, metadata: { actorId: userId, source: 'products' } }, client);
    return id;
  });
}
export async function deleteRelationship(workspaceId: string, productId: string, relationshipId: string) { const { rowCount } = await query(`DELETE FROM product_relationships WHERE workspace_id=$1 AND source_product_id=$2 AND id=$3`, [workspaceId, productId, relationshipId]); return rowCount > 0; }

export async function listCanonicalProductsForWebsite(workspaceId: string) { const { rows } = await query<Product>(`SELECT ${productSelect} FROM products p WHERE p.workspace_id=$1 AND p.deleted_at IS NULL AND p.status='ACTIVE' ORDER BY p.updated_at DESC`,[workspaceId]); return rows; }
