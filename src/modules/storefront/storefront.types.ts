export type StorefrontProduct = {
  id: string;
  slug: string;
  name: string;
  shortDescription: string | null;
  longDescription: string | null;
  currency: string | null;
  price: string | null;
  imageUrl: string | null;
  imageAlt: string | null;
  category: string | null;
};

export type StorefrontSite = {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  status: string;
  templateKey: string;
  previewUrl: string;
  customDomains: Array<{ hostname: string; status: string }>;
  plan: Record<string, unknown>;
  products: StorefrontProduct[];
  assets: Array<{ id: string; publicUrl: string; altText: string; placement: string }>;
};

export type StorefrontCartItem = StorefrontProduct & {
  variantId: string | null;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
};

export type StorefrontCart = {
  id: string;
  token: string;
  currency: string;
  status: string;
  items: StorefrontCartItem[];
  subtotal: string;
  expiresAt: string;
};
