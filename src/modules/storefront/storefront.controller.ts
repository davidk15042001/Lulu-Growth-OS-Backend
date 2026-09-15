import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../utils/app-error.js';
import { createdResponse, successResponse } from '../../utils/response.js';
import * as repo from './storefront.repo.js';
import * as websiteRepo from '../websites/website.repo.js';
import { cartItemSchema, checkoutSchema, createCartSchema, storefrontSlugSchema } from './storefront.validator.js';

function slug(req: Request) { return storefrontSlugSchema.parse(req.params).slug; }
function requestHostname(req: Request): string {
  return String(req.hostname || req.get('host') || '').trim().toLowerCase().replace(/\.$/, '').split(':')[0] ?? '';
}
function cartToken(req: Request, body?: unknown) {
  const header = req.header('x-lulu-cart-token');
  if (header) return header;
  if (body && typeof body === 'object' && typeof (body as { token?: unknown }).token === 'string') return String((body as { token: string }).token);
  throw new AppError(400, 'STOREFRONT_CART_TOKEN_REQUIRED', 'A cart token is required');
}

function escapeHtml(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] ?? character));
}

function safeImageUrl(value: unknown) {
  try {
    const url = new URL(String(value ?? ''));
    return ['http:', 'https:'].includes(url.protocol) ? url.toString() : '';
  } catch { return ''; }
}

function safeScriptJson(value: unknown) {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

export async function storefront(req: Request, res: Response, next: NextFunction) {
  try {
    const value = await repo.getPublicStorefront(slug(req));
    if (!value) throw new AppError(404, 'STOREFRONT_NOT_FOUND', 'The published Lulu storefront was not found');
    return successResponse(res, 'Lulu storefront loaded', value);
  } catch (error) { next(error); }
}

/** Render the storefront bound to a verified custom domain. */
export async function hostStorefront(req: Request, res: Response, next: NextFunction) {
  try {
    const value = await repo.getPublicStorefrontByHostname(requestHostname(req));
    if (!value) throw new AppError(404, 'STOREFRONT_DOMAIN_NOT_FOUND', 'This domain is not connected to a published Lulu storefront');
    req.params.slug = value.slug;
    return render(req, res, next);
  } catch (error) { next(error); }
}

export async function asset(req: Request, res: Response, next: NextFunction) {
  try {
    const value = await websiteRepo.getPublicManagedWebsiteAsset(String(req.params.assetId));
    if (!value) throw new AppError(404, 'STOREFRONT_ASSET_NOT_FOUND', 'The published website asset was not found');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('Content-Type', value.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${String(value.fileName).replace(/["\\\r\n]/g, '')}"`);
    return res.send(value.content);
  } catch (error) { next(error); }
}

export async function render(req: Request, res: Response, next: NextFunction) {
  try {
    const value = await repo.getPublicStorefront(slug(req));
    if (!value) throw new AppError(404, 'STOREFRONT_NOT_FOUND', 'The published Lulu storefront was not found');
    const profile = value.plan && typeof value.plan.contentProfile === 'object' ? value.plan.contentProfile as Record<string, unknown> : {};
    const home = profile.home && typeof profile.home === 'object' ? profile.home as Record<string, unknown> : {};
    const title = String(profile.siteTitle ?? value.name);
    const headline = String(home.headline ?? `Willkommen bei ${value.name}`);
    const introduction = String(home.introduction ?? 'Entdecke unsere Produkte und Leistungen.');
    const scriptNonce = randomBytes(18).toString('base64');
    const publicProducts = value.products.map(({ id, name, currency, price }) => ({ id, name, currency, price }));
    const contentServices = profile.services && typeof profile.services === 'object' ? (profile.services as Record<string, unknown>) : {};
    const serviceItems = Boolean(profile.hasServices) && Array.isArray(contentServices.items)
      ? contentServices.items.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object').slice(0, 12)
      : [];
    const serviceMarkup = serviceItems.length
      ? `<section class="services"><div class="eyebrow" style="color:#59637d;margin-bottom:12px">Leistungen</div><h2>${escapeHtml(String(contentServices.title || 'Leistungen und Lösungen'))}</h2><div class="service-grid">${serviceItems.map((item) => `<article class="service"><h3>${escapeHtml(String(item.title || 'Leistung'))}</h3><p>${escapeHtml(String(item.description || ''))}</p></article>`).join('')}</div></section>`
      : '';
    const productCards = value.products.map((item) => item.imageUrl
      ? `<article class="product"><img src="${escapeHtml(safeImageUrl(item.imageUrl))}" alt="${escapeHtml(item.imageAlt || item.name)}"><div class="product-body"><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.shortDescription || item.longDescription || '')}</p><strong>${escapeHtml(item.price ? `${item.price} ${item.currency || ''}` : 'Preis auf Anfrage')}</strong><button class="add" type="button" data-product-id="${escapeHtml(item.id)}">Anfrage hinzufügen</button></div></article>`
      : `<article class="product"><div class="product-placeholder"><span>Kein Bild</span></div><div class="product-body"><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.shortDescription || item.longDescription || '')}</p><strong>${escapeHtml(item.price ? `${item.price} ${item.currency || ''}` : 'Preis auf Anfrage')}</strong><button class="add" type="button" data-product-id="${escapeHtml(item.id)}">Anfrage hinzufügen</button></div></article>`).join('');
    const assetGallery = value.assets.length ? `<section style="margin:40px 0"><div class="eyebrow" style="color:#59637d;margin-bottom:12px">Bilder</div><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px">${value.assets.map((asset) => `<figure style="margin:0"><img src="${escapeHtml(asset.publicUrl)}" alt="${escapeHtml(asset.altText)}" style="display:block;width:100%;height:180px;object-fit:cover;border-radius:16px"><figcaption style="margin-top:8px;color:#69738d;font-size:13px">${escapeHtml(asset.altText || asset.placement)}</figcaption></figure>`).join('')}</div></section>` : '';
    if (!value.products.length) {
      const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(profile.globalSeo && typeof profile.globalSeo === 'object' ? (profile.globalSeo as Record<string, unknown>).description : introduction)}"><style>:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;color:#10142b;background:#f6f7fb}*{box-sizing:border-box}body{margin:0}header{padding:72px max(24px,calc((100% - 1160px)/2));background:linear-gradient(135deg,#20114d,#0b2640);color:#fff}.hero{max-width:760px}.hero h1{font-size:clamp(38px,6vw,72px);line-height:1.02;margin:16px 0}.hero p{font-size:18px;line-height:1.65;opacity:.86}main{max-width:1160px;margin:0 auto;padding:48px 24px 80px}.services{margin-bottom:40px}.service-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:16px}.service{padding:22px;background:#fff;border:1px solid #e2e5ef;border-radius:18px}.service h3{margin:0 0 8px}.service p{margin:0;color:#69738d;line-height:1.5}footer{max-width:1160px;margin:0 auto;padding:0 24px 36px;color:#7b849d;font-size:13px}</style></head><body><header><div class="hero"><div style="font-size:12px;letter-spacing:.16em;text-transform:uppercase;opacity:.72">${escapeHtml(title)}</div><h1>${escapeHtml(headline)}</h1><p>${escapeHtml(introduction)}</p></div></header><main>${serviceMarkup}${assetGallery}</main><footer>Powered by Lulu AI · ${escapeHtml(value.slug)}</footer></body></html>`;
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
      return res.type('html').send(html);
    }
    const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(profile.globalSeo && typeof profile.globalSeo === 'object' ? (profile.globalSeo as Record<string, unknown>).description : introduction)}"><style> :root{color-scheme:light;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;color:#10142b;background:#f6f7fb}*{box-sizing:border-box}body{margin:0}header{padding:72px max(24px,calc((100% - 1160px)/2));background:linear-gradient(135deg,#20114d,#0b2640);color:#fff}main{max-width:1160px;margin:0 auto;padding:48px 24px 80px}.eyebrow{font-size:12px;letter-spacing:.16em;text-transform:uppercase;opacity:.72}.hero{max-width:760px}.hero h1{font-size:clamp(38px,6vw,72px);line-height:1.02;margin:16px 0}.hero p{font-size:18px;line-height:1.65;opacity:.86}.services{margin-bottom:40px}.service-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:16px}.service{padding:22px;background:#fff;border:1px solid #e2e5ef;border-radius:18px}.service h3{margin:0 0 8px}.service p{margin:0;color:#69738d;line-height:1.5}.catalog{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:18px}.product{overflow:hidden;background:#fff;border:1px solid #e2e5ef;border-radius:22px;box-shadow:0 12px 35px #18204a0d}.product img,.product>div:first-child{display:block;width:100%;height:190px;object-fit:cover;background:#e9ecf5}.product>div:first-child{display:grid;place-items:center;color:#7b849d}.product-body{padding:20px}.product h3{margin:0 0 9px}.product p{min-height:52px;color:#69738d;line-height:1.5}.product strong{display:block;font-size:17px}.add,.submit{margin-top:16px;border:0;border-radius:12px;padding:11px 14px;background:#5b36e8;color:#fff;font-weight:700;cursor:pointer}.add:disabled,.submit:disabled{opacity:.55;cursor:wait}.request{margin-top:40px;border:1px solid #dfe3ef;border-radius:22px;padding:24px;background:#fff;box-shadow:0 12px 35px #18204a0d}.request-grid{display:grid;gap:12px;max-width:620px}.request input,.request textarea{width:100%;border:1px solid #cfd5e4;border-radius:10px;padding:11px;font:inherit}.notice{min-height:24px;margin-top:12px;color:#59637d}.cart-lines{margin:12px 0;color:#59637d}footer{max-width:1160px;margin:0 auto;padding:0 24px 36px;color:#7b849d;font-size:13px}@media(max-width:600px){header{padding:48px 24px}}</style></head><body><header><div class="hero"><div class="eyebrow">${escapeHtml(title)}</div><h1>${escapeHtml(headline)}</h1><p>${escapeHtml(introduction)}</p></div></header><main>${serviceMarkup}<div class="eyebrow" style="color:#59637d;margin-bottom:12px">Online Shop</div><h2>Produkte</h2><div class="catalog">${productCards || '<p>Noch keine öffentlich freigegebenen Produkte.</p>'}</div><section class="request"><h2>Produktanfrage senden</h2><p>Wähle Produkte aus und sende dem Unternehmen eine Anfrage. Es wird keine Online-Zahlung durchgeführt.</p><div id="cart-lines" class="cart-lines">Noch keine Produkte ausgewählt.</div><form id="request-form" class="request-grid"><label>E-Mail<input name="email" type="email" required maxlength="320" placeholder="du@example.com"></label><label>Nachricht / Lieferinformationen<textarea name="note" rows="4" maxlength="4000" placeholder="Wie können wir dir helfen?"></textarea></label><button class="submit" type="submit">Anfrage senden</button></form><div id="notice" class="notice" role="status"></div></section></main><footer>Powered by Lulu AI · ${escapeHtml(value.slug)}</footer><script nonce="${scriptNonce}">(function(){const slug=${safeScriptJson(value.slug)};const products=${safeScriptJson(publicProducts)};const base='/api/v1/public/storefront/'+encodeURIComponent(slug)+'/';let token=localStorage.getItem('lulu-cart:'+slug)||'';let cart=null;const notice=document.getElementById('notice');const lines=document.getElementById('cart-lines');const show=(text,ok=false)=>{notice.textContent=text;notice.style.color=ok?'#137333':'#b42318'};const call=async(path,options={})=>{const response=await fetch(base+path,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body?.error?.message||body?.message||'Die Anfrage konnte nicht verarbeitet werden.');return body.data;};const ensureCart=async()=>{if(token)return;const created=await call('cart',{method:'POST',body:JSON.stringify({currency:(products.find((item)=>item.currency)||{}).currency||'CNY'})});token=created.token;localStorage.setItem('lulu-cart:'+slug,token)};const render=()=>{if(!cart||!cart.items.length){lines.textContent='Noch keine Produkte ausgewählt.';return}lines.innerHTML=cart.items.map((item)=>'<div>'+item.name+' × '+item.quantity+' · '+item.lineTotal+' '+(item.currency||cart.currency)+'</div>').join('')+'<strong>Summe: '+cart.subtotal+' '+cart.currency+'</strong>'};document.querySelectorAll('[data-product-id]').forEach((button)=>button.addEventListener('click',async()=>{button.disabled=true;try{await ensureCart();const result=await call('cart/items',{method:'POST',headers:{'x-lulu-cart-token':token},body:JSON.stringify({token,productId:button.dataset.productId,quantity:'1'})});cart=result.cart;render();show(result.requiresQuote?'Dieses Produkt benötigt zuerst ein Angebot.':'Produkt zur Anfrage hinzugefügt.',true)}catch(error){show(error.message)}finally{button.disabled=false}}));document.getElementById('request-form').addEventListener('submit',async(event)=>{event.preventDefault();const form=new FormData(event.currentTarget);if(!cart?.items?.length){show('Bitte wähle zuerst mindestens ein Produkt aus.');return}const button=event.currentTarget.querySelector('button[type=submit]');button.disabled=true;try{await ensureCart();const result=await call('checkout',{method:'POST',headers:{'x-lulu-cart-token':token},body:JSON.stringify({token,email:String(form.get('email')||''),shippingAddress:{note:String(form.get('note')||'')}})});show(result.message||'Anfrage erhalten.',true);event.currentTarget.reset()}catch(error){show(error.message)}finally{button.disabled=false}})})();</script></body></html>`;
    res.setHeader('Content-Security-Policy', `default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`);
    return res.type('html').send(html.replace('<section class="request">', `${assetGallery}<section class="request">`));
  } catch (error) { next(error); }
}

export async function products(req: Request, res: Response, next: NextFunction) {
  try {
    const value = await repo.listPublicProducts(slug(req));
    if (!value) throw new AppError(404, 'STOREFRONT_NOT_FOUND', 'The published Lulu storefront was not found');
    return successResponse(res, 'Storefront products loaded', { items: value });
  } catch (error) { next(error); }
}

export async function product(req: Request, res: Response, next: NextFunction) {
  try {
    const value = await repo.getPublicProduct(slug(req), String(req.params.productSlug));
    if (!value) throw new AppError(404, 'STOREFRONT_PRODUCT_NOT_FOUND', 'The storefront product was not found');
    return successResponse(res, 'Storefront product loaded', value);
  } catch (error) { next(error); }
}

export async function createCart(req: Request, res: Response, next: NextFunction) {
  try {
    const value = await repo.createCart(slug(req), createCartSchema.parse(req.body).currency);
    if (!value) throw new AppError(404, 'STOREFRONT_NOT_FOUND', 'The published Lulu storefront was not found');
    return createdResponse(res, 'Storefront cart created', value);
  } catch (error) { next(error); }
}

export async function getCart(req: Request, res: Response, next: NextFunction) {
  try {
    const value = await repo.getCart(slug(req), cartToken(req));
    if (!value) throw new AppError(404, 'STOREFRONT_CART_NOT_FOUND', 'The storefront cart was not found or has expired');
    return successResponse(res, 'Storefront cart loaded', value);
  } catch (error) { next(error); }
}

export async function addCartItem(req: Request, res: Response, next: NextFunction) {
  try {
    const input = cartItemSchema.parse({ ...req.body, token: cartToken(req, req.body) });
    const result = await repo.addCartItem(slug(req), input.token, input.productId, input.variantId ?? null, input.quantity);
    if (result === null) throw new AppError(404, 'STOREFRONT_PRODUCT_NOT_FOUND', 'The product is not available in this storefront');
    if (result === undefined) throw new AppError(404, 'STOREFRONT_CART_NOT_FOUND', 'The storefront cart was not found or has expired');
    return successResponse(res, result.requiresQuote ? 'Product requires a quote before it can be added to checkout' : 'Product added to cart', result);
  } catch (error) { next(error); }
}

export async function checkout(req: Request, res: Response, next: NextFunction) {
  try {
    const input = checkoutSchema.parse({ ...req.body, token: cartToken(req, req.body) });
    const result = await repo.createCheckout(slug(req), input.token, input.email, input.shippingAddress);
    if (!result) throw new AppError(404, 'STOREFRONT_NOT_FOUND', 'The published Lulu storefront was not found');
    if (result === undefined) throw new AppError(404, 'STOREFRONT_CART_NOT_FOUND', 'The storefront cart was not found or has expired');
    if ('empty' in result) throw new AppError(400, 'STOREFRONT_CART_EMPTY', 'Add at least one product before checkout');
    return createdResponse(res, 'Checkout session created', result);
  } catch (error) { next(error); }
}
