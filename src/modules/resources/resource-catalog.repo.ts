import { RESOURCE_CATALOG } from '../../domain/resource-catalog.js';
import { query } from '../../db/pool.js';

export async function syncResourceCatalog() {
  const values: unknown[] = [];
  const placeholders = RESOURCE_CATALOG.map((resource, index) => {
    const offset = index * 4;
    values.push(resource.key, resource.domain, resource.label, resource.description);
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4})`;
  });

  await query(
    `INSERT INTO resource_types (key, domain, label, description)
     VALUES ${placeholders.join(', ')}
     ON CONFLICT (key) DO UPDATE SET
       domain = EXCLUDED.domain,
       label = EXCLUDED.label,
       description = EXCLUDED.description`,
    values
  );
}
