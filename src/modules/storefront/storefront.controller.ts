import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../../utils/app-error.js';
import { createdResponse, successResponse } from '../../utils/response.js';
import * as repo from './storefront.repo.js';
import * as websiteRepo from '../websites/website.repo.js';
import { cartItemSchema, checkoutSchema, contactRequestSchema, createCartSchema, storefrontSlugSchema } from './storefront.validator.js';

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

type StorefrontLocale = 'de' | 'en' | 'zh';
const STOREFRONT_UI: Record<StorefrontLocale, { language: string; services: string; serviceFallback: string; shop: string; products: string; priceOnRequest: string; noProducts: string; request: string; requestBody: string; noSelection: string; email: string; website: string; whatsapp: string; file: string; fileHint: string; fileTooLarge: string; note: string; notePlaceholder: string; send: string; poweredBy: string; welcome: string; introduction: string; add: string; quote: string; added: string; requestReceived: string; selectFirst: string; failed: string; productFallback: string }> = {
  de: { language: 'Sprache', services: 'Leistungen', serviceFallback: 'Leistungen und Lösungen', shop: 'Online-Shop', products: 'Produkte', priceOnRequest: 'Preis auf Anfrage', noProducts: 'Noch keine öffentlich freigegebenen Produkte.', request: 'Anfrage senden', requestBody: 'Sende dem Unternehmen deine Anfrage. Es wird keine Online-Zahlung durchgeführt.', noSelection: 'Noch keine Produkte ausgewählt.', email: 'E-Mail', website: 'Website-Link', whatsapp: 'WhatsApp-Nummer', file: 'Datei anhängen', fileHint: 'Optional, maximal 5 MB', fileTooLarge: 'Die Datei darf höchstens 5 MB groß sein.', note: 'Nachricht / Lieferinformationen', notePlaceholder: 'Wie können wir dir helfen?', send: 'Anfrage senden', poweredBy: 'Powered by Lulu AI', welcome: 'Willkommen bei', introduction: 'Entdecke unsere Produkte und Leistungen.', add: 'Anfrage hinzufügen', quote: 'Dieses Produkt benötigt zuerst ein Angebot.', added: 'Produkt zur Anfrage hinzugefügt.', requestReceived: 'Anfrage erhalten.', selectFirst: 'Bitte wähle zuerst mindestens ein Produkt aus.', failed: 'Die Anfrage konnte nicht verarbeitet werden.', productFallback: 'Kein Bild' },
  en: { language: 'Language', services: 'Services', serviceFallback: 'Services and solutions', shop: 'Online shop', products: 'Products', priceOnRequest: 'Price on request', noProducts: 'No publicly available products yet.', request: 'Send an enquiry', requestBody: 'Send the company your enquiry. No online payment is processed.', noSelection: 'No products selected yet.', email: 'Email', website: 'Website link', whatsapp: 'WhatsApp number', file: 'Attach a file', fileHint: 'Optional, maximum 5 MB', fileTooLarge: 'The file must be 5 MB or smaller.', note: 'Message / delivery information', notePlaceholder: 'How can we help?', send: 'Send enquiry', poweredBy: 'Powered by Lulu AI', welcome: 'Welcome to', introduction: 'Discover our products and services.', add: 'Add to request', quote: 'This product requires a quote first.', added: 'Product added to your request.', requestReceived: 'Request received.', selectFirst: 'Please select at least one product first.', failed: 'The request could not be processed.', productFallback: 'No image' },
  zh: { language: '语言', services: '服务', serviceFallback: '服务与解决方案', shop: '在线商店', products: '产品', priceOnRequest: '价格咨询', noProducts: '暂无公开产品。', request: '发送咨询', requestBody: '向企业发送咨询。此处不进行在线支付。', noSelection: '尚未选择产品。', email: '电子邮件', website: '网站链接', whatsapp: 'WhatsApp 号码', file: '附加文件', fileHint: '可选，最大 5 MB', fileTooLarge: '文件大小不能超过 5 MB。', note: '留言 / 配送信息', notePlaceholder: '我们可以如何帮助你？', send: '发送咨询', poweredBy: '由 Lulu AI 提供支持', welcome: '欢迎来到', introduction: '探索我们的产品和服务。', add: '加入咨询', quote: '此产品需要先获取报价。', added: '产品已加入咨询。', requestReceived: '已收到咨询。', selectFirst: '请先选择至少一个产品。', failed: '无法处理此请求。', productFallback: '暂无图片' }
};

function storefrontLocale(req: Request): StorefrontLocale {
  const value = String(req.query.lang ?? '').trim().toLowerCase();
  return value === 'en' || value === 'zh' ? value : 'de';
}

function localePicker(locale: StorefrontLocale, labels: (typeof STOREFRONT_UI)[StorefrontLocale]) {
  return `<label class="locale-picker"><span>${escapeHtml(labels.language)}</span><select id="lulu-language" aria-label="${escapeHtml(labels.language)}"><option value="de"${locale === 'de' ? ' selected' : ''}>Deutsch</option><option value="en"${locale === 'en' ? ' selected' : ''}>English</option><option value="zh"${locale === 'zh' ? ' selected' : ''}>中文</option></select></label>`;
}

function localeScript(scriptNonce: string) {
  return `<script nonce="${scriptNonce}">(function(){var picker=document.getElementById('lulu-language');if(!picker)return;picker.addEventListener('change',function(){var url=new URL(window.location.href);url.searchParams.set('lang',picker.value);window.location.assign(url.toString())})})();</script>`;
}

function requestFields(labels: (typeof STOREFRONT_UI)[StorefrontLocale]) {
  return `<label>${escapeHtml(labels.email)}<input name="email" type="email" required maxlength="320" placeholder="${escapeHtml(labels.email)}"></label><label>${escapeHtml(labels.website)}<input name="websiteUrl" type="url" maxlength="2000" placeholder="https://example.com"></label><label>${escapeHtml(labels.whatsapp)}<input name="whatsappNumber" type="tel" maxlength="40" placeholder="+49 123 456789"></label><label>${escapeHtml(labels.file)}<input name="attachment" type="file" accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt"></label><small style="color:#69738d">${escapeHtml(labels.fileHint)}</small><label>${escapeHtml(labels.note)}<textarea name="note" rows="4" maxlength="4000" placeholder="${escapeHtml(labels.notePlaceholder)}"></textarea></label>`;
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
    if (!value) throw new AppError(404, 'STOREFRONT_DOMAIN_NOT_FOUND', 'This domain is not connected to a Lulu website');
    req.params.slug = value.slug;
    // A verified domain is allowed to render the neutral template before the
    // first publication. The same site record is used after publication, so
    // the domain automatically reflects every later website update.
    return renderStorefront(req, res, next, true);
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

async function renderStorefront(req: Request, res: Response, next: NextFunction, allowUnpublished = false) {
  try {
    const value = await repo.getPublicStorefront(slug(req), { allowUnpublished });
    if (!value) throw new AppError(404, 'STOREFRONT_NOT_FOUND', 'The published Lulu storefront was not found');
    const locale = storefrontLocale(req);
    const ui = STOREFRONT_UI[locale];
    const profile = value.plan && typeof value.plan.contentProfile === 'object' ? value.plan.contentProfile as Record<string, unknown> : {};
    const home = profile.home && typeof profile.home === 'object' ? profile.home as Record<string, unknown> : {};
    const title = String(profile.siteTitle ?? value.name);
    const headline = String(home.headline ?? `${ui.welcome} ${value.name}`);
    const introduction = String(home.introduction ?? ui.introduction);
    const scriptNonce = randomBytes(18).toString('base64');
    const publicProducts = value.products.map(({ id, name, currency, price }) => ({ id, name, currency, price }));
    const contentServices = profile.services && typeof profile.services === 'object' ? (profile.services as Record<string, unknown>) : {};
    const serviceItems = Boolean(profile.hasServices) && Array.isArray(contentServices.items)
      ? contentServices.items.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object').slice(0, 12)
      : [];
    const serviceMarkup = serviceItems.length
      ? `<section class="services"><div class="eyebrow" style="color:#59637d;margin-bottom:12px">${escapeHtml(ui.services)}</div><h2>${escapeHtml(String(contentServices.title || ui.serviceFallback))}</h2><div class="service-grid">${serviceItems.map((item) => `<article class="service"><h3>${escapeHtml(String(item.title || ui.services))}</h3><p>${escapeHtml(String(item.description || ''))}</p></article>`).join('')}</div></section>`
      : '';
    const productCards = value.products.map((item) => item.imageUrl
      ? `<article class="product"><img src="${escapeHtml(safeImageUrl(item.imageUrl))}" alt="${escapeHtml(item.imageAlt || item.name)}"><div class="product-body"><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.shortDescription || item.longDescription || '')}</p><strong>${escapeHtml(item.price ? `${item.price} ${item.currency || ''}` : ui.priceOnRequest)}</strong><button class="add" type="button" data-product-id="${escapeHtml(item.id)}">${escapeHtml(ui.add)}</button></div></article>`
      : `<article class="product"><div class="product-placeholder"><span>${escapeHtml(ui.productFallback)}</span></div><div class="product-body"><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(item.shortDescription || item.longDescription || '')}</p><strong>${escapeHtml(item.price ? `${item.price} ${item.currency || ''}` : ui.priceOnRequest)}</strong><button class="add" type="button" data-product-id="${escapeHtml(item.id)}">${escapeHtml(ui.add)}</button></div></article>`).join('');
    const assetGallery = value.assets.length ? `<section style="margin:40px 0"><div class="eyebrow" style="color:#59637d;margin-bottom:12px">${escapeHtml(locale === 'zh' ? '图片' : locale === 'en' ? 'Images' : 'Bilder')}</div><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px">${value.assets.map((asset) => `<figure style="margin:0"><img src="${escapeHtml(asset.publicUrl)}" alt="${escapeHtml(asset.altText)}" style="display:block;width:100%;height:180px;object-fit:cover;border-radius:16px"><figcaption style="margin-top:8px;color:#69738d;font-size:13px">${escapeHtml(asset.altText || asset.placement)}</figcaption></figure>`).join('')}</div></section>` : '';
    const requestFieldMarkup = requestFields(ui);
    const legacyRequestFields = `<label>${escapeHtml(ui.email)}<input name="email" type="email" required maxlength="320" placeholder="${escapeHtml(ui.email)}"></label><label>${escapeHtml(ui.note)}<textarea name="note" rows="4" maxlength="4000" placeholder="${escapeHtml(ui.notePlaceholder)}"></textarea></label>`;
    const contactMarkup = `<section class="request"><h2>${escapeHtml(ui.request)}</h2><p>${escapeHtml(ui.requestBody)}</p><form id="contact-form" class="request-grid">${requestFieldMarkup}<button class="submit" type="submit">${escapeHtml(ui.send)}</button></form><div id="contact-notice" class="notice" role="status"></div></section>`;
    const contactScript = `<script nonce="${scriptNonce}">(function(){const slug=${safeScriptJson(value.slug)};const base='/api/v1/public/storefront/'+encodeURIComponent(slug)+'/';const notice=document.getElementById('contact-notice');const show=(text,ok=false)=>{notice.textContent=text;notice.style.color=ok?'#137333':'#b42318'};const readAttachment=async(file)=>{if(!(file instanceof File)||!file.size)return undefined;if(file.size>5*1024*1024){show('${ui.fileTooLarge}');throw new Error('file-too-large')}const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result||''));reader.onerror=reject;reader.readAsDataURL(file)});return {fileName:file.name,mimeType:file.type||'application/octet-stream',sizeBytes:file.size,dataBase64:String(dataUrl).split(',')[1]||''}};document.getElementById('contact-form').addEventListener('submit',async(event)=>{event.preventDefault();const form=new FormData(event.currentTarget);const button=event.currentTarget.querySelector('button[type=submit]');button.disabled=true;try{const attachment=await readAttachment(form.get('attachment'));const response=await fetch(base+'contact',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:String(form.get('email')||''),requestDetails:{websiteUrl:String(form.get('websiteUrl')||''),whatsappNumber:String(form.get('whatsappNumber')||''),note:String(form.get('note')||''),...(attachment?{attachment}:{})}})});const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body?.error?.message||'${ui.failed}');show(body?.data?.message||'${ui.requestReceived}',true);event.currentTarget.reset()}catch(error){if(error.message!=='file-too-large')show(error.message||'${ui.failed}')}finally{button.disabled=false}})})();</script>`;
    if (!value.products.length) {
      const html = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(profile.globalSeo && typeof profile.globalSeo === 'object' ? (profile.globalSeo as Record<string, unknown>).description : introduction)}"><style>:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;color:#10142b;background:#f6f7fb}*{box-sizing:border-box}body{margin:0}header{padding:32px max(24px,calc((100% - 1160px)/2)) 72px;background:linear-gradient(135deg,#20114d,#0b2640);color:#fff}.topbar{display:flex;justify-content:space-between;align-items:center;gap:20px;margin-bottom:56px}.locale-picker{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.locale-picker select{border:1px solid #ffffff55;border-radius:999px;background:#ffffff18;color:#fff;padding:8px 12px;font:inherit;text-transform:none}.locale-picker option{color:#10142b;background:#fff}.hero{max-width:760px}.hero h1{font-size:clamp(38px,6vw,72px);line-height:1.02;margin:16px 0}.hero p{font-size:18px;line-height:1.65;opacity:.86}main{max-width:1160px;margin:0 auto;padding:48px 24px 80px}.services{margin-bottom:40px}.service-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:16px}.service{padding:22px;background:#fff;border:1px solid #e2e5ef;border-radius:18px}.service h3{margin:0 0 8px}.service p{margin:0;color:#69738d;line-height:1.5}.request{margin-top:40px;border:1px solid #dfe3ef;border-radius:22px;padding:24px;background:#fff}.request-grid{display:grid;gap:12px;max-width:620px}.request input,.request textarea{width:100%;border:1px solid #cfd5e4;border-radius:10px;padding:11px;font:inherit}.submit{margin-top:16px;border:0;border-radius:12px;padding:11px 14px;background:#5b36e8;color:#fff;font-weight:700;cursor:pointer}.notice{min-height:24px;margin-top:12px;color:#59637d}footer{max-width:1160px;margin:0 auto;padding:0 24px 36px;color:#7b849d;font-size:13px}</style></head><body><header><div class="topbar"><div style="font-size:12px;letter-spacing:.16em;text-transform:uppercase;opacity:.72">${escapeHtml(title)}</div>${localePicker(locale, ui)}</div><div class="hero"><h1>${escapeHtml(headline)}</h1><p>${escapeHtml(introduction)}</p></div></header><main>${serviceMarkup}${assetGallery}${contactMarkup}</main><footer>${escapeHtml(ui.poweredBy)} · ${escapeHtml(value.slug)}</footer>${contactScript}${localeScript(scriptNonce)}</body></html>`;
      res.setHeader('Content-Security-Policy', `default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}'; base-uri 'none'; frame-ancestors 'none'`);
      return res.type('html').send(html);
    }
    const html = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(profile.globalSeo && typeof profile.globalSeo === 'object' ? (profile.globalSeo as Record<string, unknown>).description : introduction)}"><style> :root{color-scheme:light;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;color:#10142b;background:#f6f7fb}*{box-sizing:border-box}body{margin:0}header{padding:32px max(24px,calc((100% - 1160px)/2)) 72px;background:linear-gradient(135deg,#20114d,#0b2640);color:#fff}.topbar{display:flex;justify-content:space-between;align-items:center;gap:20px;margin-bottom:56px}.locale-picker{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.locale-picker select{border:1px solid #ffffff55;border-radius:999px;background:#ffffff18;color:#fff;padding:8px 12px;font:inherit;text-transform:none}.locale-picker option{color:#10142b;background:#fff}main{max-width:1160px;margin:0 auto;padding:48px 24px 80px}.eyebrow{font-size:12px;letter-spacing:.16em;text-transform:uppercase;opacity:.72}.hero{max-width:760px}.hero h1{font-size:clamp(38px,6vw,72px);line-height:1.02;margin:16px 0}.hero p{font-size:18px;line-height:1.65;opacity:.86}.services{margin-bottom:40px}.service-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:16px}.service{padding:22px;background:#fff;border:1px solid #e2e5ef;border-radius:18px}.service h3{margin:0 0 8px}.service p{margin:0;color:#69738d;line-height:1.5}.catalog{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:18px}.product{overflow:hidden;background:#fff;border:1px solid #e2e5ef;border-radius:22px;box-shadow:0 12px 35px #18204a0d}.product img,.product>div:first-child{display:block;width:100%;height:190px;object-fit:cover;background:#e9ecf5}.product>div:first-child{display:grid;place-items:center;color:#7b849d}.product-body{padding:20px}.product h3{margin:0 0 9px}.product p{min-height:52px;color:#69738d;line-height:1.5}.product strong{display:block;font-size:17px}.add,.submit{margin-top:16px;border:0;border-radius:12px;padding:11px 14px;background:#5b36e8;color:#fff;font-weight:700;cursor:pointer}.add:disabled,.submit:disabled{opacity:.55;cursor:wait}.request{margin-top:40px;border:1px solid #dfe3ef;border-radius:22px;padding:24px;background:#fff;box-shadow:0 12px 35px #18204a0d}.request-grid{display:grid;gap:12px;max-width:620px}.request input,.request textarea{width:100%;border:1px solid #cfd5e4;border-radius:10px;padding:11px;font:inherit}.notice{min-height:24px;margin-top:12px;color:#59637d}.cart-lines{margin:12px 0;color:#59637d}footer{max-width:1160px;margin:0 auto;padding:0 24px 36px;color:#7b849d;font-size:13px}@media(max-width:600px){header{padding:48px 24px}}</style></head><body><header><div class="topbar"><div class="eyebrow">${escapeHtml(title)}</div>${localePicker(locale, ui)}</div><div class="hero"><h1>${escapeHtml(headline)}</h1><p>${escapeHtml(introduction)}</p></div></header><main>${serviceMarkup}<div class="eyebrow" style="color:#59637d;margin-bottom:12px">${escapeHtml(ui.shop)}</div><h2>${escapeHtml(ui.products)}</h2><div class="catalog">${productCards || `<p>${escapeHtml(ui.noProducts)}</p>`}</div><section class="request"><h2>${escapeHtml(ui.request)}</h2><p>${escapeHtml(ui.requestBody)}</p><div id="cart-lines" class="cart-lines">${escapeHtml(ui.noSelection)}</div><form id="request-form" class="request-grid"><label>${escapeHtml(ui.email)}<input name="email" type="email" required maxlength="320" placeholder="${escapeHtml(ui.email)}"></label><label>${escapeHtml(ui.note)}<textarea name="note" rows="4" maxlength="4000" placeholder="${escapeHtml(ui.notePlaceholder)}"></textarea></label><button class="submit" type="submit">${escapeHtml(ui.send)}</button></form><div id="notice" class="notice" role="status"></div></section></main><footer>${escapeHtml(ui.poweredBy)} · ${escapeHtml(value.slug)}</footer><script nonce="${scriptNonce}">(function(){const slug=${safeScriptJson(value.slug)};const products=${safeScriptJson(publicProducts)};const base='/api/v1/public/storefront/'+encodeURIComponent(slug)+'/';let token=localStorage.getItem('lulu-cart:'+slug)||'';let cart=null;const notice=document.getElementById('notice');const lines=document.getElementById('cart-lines');const show=(text,ok=false)=>{notice.textContent=text;notice.style.color=ok?'#137333':'#b42318'};const call=async(path,options={})=>{const response=await fetch(base+path,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body?.error?.message||body?.message||'${ui.failed}');return body.data;};const ensureCart=async()=>{if(token)return;const created=await call('cart',{method:'POST',body:JSON.stringify({currency:(products.find((item)=>item.currency)||{}).currency||'CNY'})});token=created.token;localStorage.setItem('lulu-cart:'+slug,token)};const render=()=>{if(!cart||!cart.items.length){lines.textContent='${ui.noSelection}';return}lines.innerHTML=cart.items.map((item)=>'<div>'+item.name+' × '+item.quantity+' · '+item.lineTotal+' '+(item.currency||cart.currency)+'</div>').join('')+'<strong>Sum: '+cart.subtotal+' '+cart.currency+'</strong>'};document.querySelectorAll('[data-product-id]').forEach((button)=>button.addEventListener('click',async()=>{button.disabled=true;try{await ensureCart();const result=await call('cart/items',{method:'POST',headers:{'x-lulu-cart-token':token},body:JSON.stringify({token,productId:button.dataset.productId,quantity:'1'})});cart=result.cart;render();show(result.requiresQuote?'${ui.quote}':'${ui.added}',true)}catch(error){show(error.message)}finally{button.disabled=false}}));document.getElementById('request-form').addEventListener('submit',async(event)=>{event.preventDefault();const form=new FormData(event.currentTarget);if(!cart?.items?.length){show('${ui.selectFirst}');return}const button=event.currentTarget.querySelector('button[type=submit]');button.disabled=true;try{await ensureCart();const result=await call('checkout',{method:'POST',headers:{'x-lulu-cart-token':token},body:JSON.stringify({token,email:String(form.get('email')||''),shippingAddress:{note:String(form.get('note')||'')}})});show(result.message||'${ui.requestReceived}',true);event.currentTarget.reset()}catch(error){show(error.message)}finally{button.disabled=false}})})();</script>${localeScript(scriptNonce)}</body></html>`;
    const requestEnhancementScript = `<script nonce="${scriptNonce}">(function(){const slug=${safeScriptJson(value.slug)};const tokenKey='lulu-cart:'+slug;const base='/api/v1/public/storefront/'+encodeURIComponent(slug)+'/';const notice=document.getElementById('notice');const show=(text,ok=false)=>{notice.textContent=text;notice.style.color=ok?'#137333':'#b42318'};const readAttachment=async(file)=>{if(!(file instanceof File)||!file.size)return undefined;if(file.size>5*1024*1024){show('${ui.fileTooLarge}');throw new Error('file-too-large')}const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result||''));reader.onerror=reject;reader.readAsDataURL(file)});return {fileName:file.name,mimeType:file.type||'application/octet-stream',sizeBytes:file.size,dataBase64:String(dataUrl).split(',')[1]||''}};document.getElementById('request-form').addEventListener('submit',async(event)=>{event.preventDefault();event.stopImmediatePropagation();const form=new FormData(event.currentTarget);const token=localStorage.getItem(tokenKey);const button=event.currentTarget.querySelector('button[type=submit]');button.disabled=true;try{if(!token){show('${ui.selectFirst}');return}const cartResponse=await fetch(base+'cart',{headers:{'x-lulu-cart-token':token}});const cartBody=await cartResponse.json().catch(()=>({}));if(!cartResponse.ok||!cartBody?.data?.items?.length){show('${ui.selectFirst}');return}const attachment=await readAttachment(form.get('attachment'));const response=await fetch(base+'checkout',{method:'POST',headers:{'Content-Type':'application/json','x-lulu-cart-token':token},body:JSON.stringify({token,email:String(form.get('email')||''),shippingAddress:{websiteUrl:String(form.get('websiteUrl')||''),whatsappNumber:String(form.get('whatsappNumber')||''),note:String(form.get('note')||''),...(attachment?{attachment}:{})}})});const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body?.error?.message||'${ui.failed}');show(body?.data?.message||'${ui.requestReceived}',true);event.currentTarget.reset()}catch(error){if(error.message!=='file-too-large')show(error.message||'${ui.failed}')}finally{button.disabled=false}},true)})();</script>`;
    const renderedHtml = html.replace(`<form id="request-form" class="request-grid">${legacyRequestFields}`, `<form id="request-form" class="request-grid">${requestFieldMarkup}`).replace('</body>', `${requestEnhancementScript}</body>`);
    res.setHeader('Content-Security-Policy', `default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`);
    return res.type('html').send(renderedHtml.replace('<section class="request">', `${assetGallery}<section class="request">`));
  } catch (error) { next(error); }
}

export async function render(req: Request, res: Response, next: NextFunction) {
  return renderStorefront(req, res, next, false);
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

export async function contact(req: Request, res: Response, next: NextFunction) {
  try {
    const input = contactRequestSchema.parse(req.body);
    const result = await repo.createContactRequest(slug(req), input.email, input.requestDetails);
    if (!result) throw new AppError(404, 'STOREFRONT_NOT_FOUND', 'The published Lulu storefront was not found');
    return createdResponse(res, 'Contact request created', result);
  } catch (error) { next(error); }
}
