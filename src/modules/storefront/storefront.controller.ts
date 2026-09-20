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
    const trustItems = Array.isArray(home.trustItems) ? home.trustItems.map((item) => String(item)).filter(Boolean).slice(0, 5) : [];
    const serviceTitle = String(contentServices.title || ui.serviceFallback);
    const serviceMarkup = serviceItems.length
      ? `<section class="section-panel services" id="services"><div class="section-head"><div><p class="eyebrow">${escapeHtml(ui.services)}</p><h2>${escapeHtml(serviceTitle)}</h2></div><p>${escapeHtml(String(contentServices.introduction || introduction))}</p></div><div class="service-grid">${serviceItems.map((item, index) => `<article class="service"><span>${String(index + 1).padStart(2, '0')}</span><h3>${escapeHtml(String(item.title || ui.services))}</h3><p>${escapeHtml(String(item.description || ''))}</p></article>`).join('')}</div></section>`
      : '';
    const productCards = value.products.map((item, index) => {
      const image = safeImageUrl(item.imageUrl);
      const description = item.shortDescription || item.longDescription || introduction;
      const price = item.price ? `${item.price} ${item.currency || ''}` : ui.priceOnRequest;
      return `<article class="product"><div class="product-media">${image ? `<img src="${escapeHtml(image)}" alt="${escapeHtml(item.imageAlt || item.name)}">` : `<div class="product-placeholder"><span>${escapeHtml(ui.productFallback)}</span></div>`}<b>${String(index + 1).padStart(2, '0')}</b></div><div class="product-body"><p class="mini">${escapeHtml(item.category || ui.products)}</p><h3>${escapeHtml(item.name)}</h3><p>${escapeHtml(description)}</p><strong>${escapeHtml(price)}</strong><button class="add" type="button" data-product-id="${escapeHtml(item.id)}">${escapeHtml(ui.add)}</button></div></article>`;
    }).join('');
    const assetGallery = value.assets.length ? `<section class="section-panel gallery"><div class="section-head"><div><p class="eyebrow">${escapeHtml(locale === 'zh' ? '图片' : locale === 'en' ? 'Images' : 'Bilder')}</p><h2>${escapeHtml(locale === 'zh' ? '品牌视觉' : locale === 'en' ? 'Brand visuals' : 'Markenbilder')}</h2></div><p>${escapeHtml(introduction)}</p></div><div class="gallery-grid">${value.assets.map((asset) => `<figure><img src="${escapeHtml(asset.publicUrl)}" alt="${escapeHtml(asset.altText)}"><figcaption>${escapeHtml(asset.altText || asset.placement)}</figcaption></figure>`).join('')}</div></section>` : '';
    const routingCards = [
      { label: ui.products, title: ui.products, body: value.products.length ? `${value.products.length} ${ui.products}` : ui.noProducts, href: '#products' },
      { label: ui.services, title: serviceTitle, body: serviceItems.length ? String(contentServices.introduction || introduction) : ui.serviceFallback, href: '#services' },
      { label: ui.request, title: ui.request, body: ui.requestBody, href: '#request' },
    ];
    const routingMarkup = `<section class="section-panel routing"><div class="section-head"><div><p class="eyebrow">${escapeHtml(locale === 'zh' ? '入口' : locale === 'en' ? 'Start here' : 'Direkt starten')}</p><h2>${escapeHtml(locale === 'zh' ? '你需要什么？' : locale === 'en' ? 'What do you need?' : 'Was brauchst du?')}</h2></div><p>${escapeHtml(introduction)}</p></div><div class="routing-grid">${routingCards.map((card, index) => `<a class="routing-card" href="${escapeHtml(card.href)}"><span>${String(index + 1).padStart(2, '0')}</span><small>${escapeHtml(card.label)}</small><strong>${escapeHtml(card.title)}</strong><p>${escapeHtml(card.body)}</p></a>`).join('')}</div></section>`;
    const proofItems = (trustItems.length ? trustItems : [ui.services, ui.products, ui.request]).slice(0, 6);
    const proofMarkup = `<section class="section-panel proof"><div class="section-head"><div><p class="eyebrow">${escapeHtml(locale === 'zh' ? '信任' : locale === 'en' ? 'Trust' : 'Vertrauen')}</p><h2>${escapeHtml(locale === 'zh' ? '质量与可信度' : locale === 'en' ? 'Quality and proof' : 'Qualität und Nachweise')}</h2></div><p>${escapeHtml(introduction)}</p></div><div class="proof-grid">${proofItems.map((item, index) => `<article><span>${String(index + 1).padStart(2, '0')}</span><strong>${escapeHtml(item)}</strong><p>${escapeHtml(locale === 'zh' ? '基于已验证的企业信息展示。' : locale === 'en' ? 'Shown from verified company information.' : 'Aus verifizierten Unternehmensinformationen dargestellt.')}</p></article>`).join('')}</div></section>`;
    const resourceMarkup = `<section class="section-panel resources"><div class="section-head"><div><p class="eyebrow">${escapeHtml(locale === 'zh' ? '资源' : locale === 'en' ? 'Resources' : 'Ressourcen')}</p><h2>${escapeHtml(locale === 'zh' ? '资料、常见问题与下一步' : locale === 'en' ? 'Downloads, FAQ and next steps' : 'Downloads, FAQ und nächste Schritte')}</h2></div><p>${escapeHtml(ui.requestBody)}</p></div><div class="resource-grid"><article><h3>${escapeHtml(ui.products)}</h3><p>${escapeHtml(value.products.length ? `${value.products.length} ${ui.products}` : ui.noProducts)}</p></article><article><h3>${escapeHtml(ui.services)}</h3><p>${escapeHtml(serviceItems.length ? serviceTitle : ui.serviceFallback)}</p></article><article><h3>${escapeHtml(ui.request)}</h3><p>${escapeHtml(ui.requestBody)}</p></article></div></section>`;
    const requestFieldMarkup = requestFields(ui);
    const contactMarkup = `<section class="section-panel request"><div class="section-head"><div><p class="eyebrow">${escapeHtml(ui.request)}</p><h2>${escapeHtml(ui.request)}</h2></div><p>${escapeHtml(ui.requestBody)}</p></div><form id="contact-form" class="request-grid">${requestFieldMarkup}<button class="submit" type="submit">${escapeHtml(ui.send)}</button></form><div id="contact-notice" class="notice" role="status"></div></section>`;
    const contactScript = `<script nonce="${scriptNonce}">(function(){const slug=${safeScriptJson(value.slug)};const base='/api/v1/public/storefront/'+encodeURIComponent(slug)+'/';const notice=document.getElementById('contact-notice');const show=(text,ok=false)=>{notice.textContent=text;notice.style.color=ok?'#137333':'#b42318'};const readAttachment=async(file)=>{if(!(file instanceof File)||!file.size)return undefined;if(file.size>5*1024*1024){show('${ui.fileTooLarge}');throw new Error('file-too-large')}const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result||''));reader.onerror=reject;reader.readAsDataURL(file)});return {fileName:file.name,mimeType:file.type||'application/octet-stream',sizeBytes:file.size,dataBase64:String(dataUrl).split(',')[1]||''}};document.getElementById('contact-form').addEventListener('submit',async(event)=>{event.preventDefault();const form=new FormData(event.currentTarget);const button=event.currentTarget.querySelector('button[type=submit]');button.disabled=true;try{const attachment=await readAttachment(form.get('attachment'));const response=await fetch(base+'contact',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:String(form.get('email')||''),requestDetails:{websiteUrl:String(form.get('websiteUrl')||''),whatsappNumber:String(form.get('whatsappNumber')||''),note:String(form.get('note')||''),...(attachment?{attachment}:{})}})});const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body?.error?.message||'${ui.failed}');show(body?.data?.message||'${ui.requestReceived}',true);event.currentTarget.reset()}catch(error){if(error.message!=='file-too-large')show(error.message||'${ui.failed}')}finally{button.disabled=false}})})();</script>`;
    const storefrontStyle = `:root{color-scheme:light;--ink:#101820;--muted:#64707d;--line:#dce2e8;--paper:#f6f8fb;--card:#fff;--dark:#0b1726;--accent:#ff6b2c;--accent2:#18b7c8;--primary:#123a5a;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);background:var(--paper)}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:linear-gradient(180deg,#eef3f7 0,#fff 52%,#eef3f7 100%)}a,button,input,textarea,select{font:inherit}.site-header{position:sticky;top:0;z-index:20;border-bottom:1px solid rgba(255,255,255,.16);background:rgba(11,23,38,.84);backdrop-filter:blur(18px);color:#fff}.topbar{width:min(1240px,calc(100% - 40px));min-height:76px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;gap:18px}.brand{display:flex;align-items:center;gap:12px;min-width:0}.brand-mark{display:grid;place-items:center;width:42px;height:42px;border-radius:8px;background:linear-gradient(135deg,var(--accent),#ffb15f);color:#fff;font-weight:900;box-shadow:0 16px 40px rgba(255,107,44,.28)}.brand strong{display:block;max-width:min(46vw,420px);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;letter-spacing:.08em;text-transform:uppercase}.brand small{display:block;margin-top:4px;color:rgba(255,255,255,.62);font-size:11px}.locale-picker{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.locale-picker select{height:38px;border:1px solid rgba(255,255,255,.28);border-radius:8px;background:rgba(255,255,255,.1);color:#fff;padding:0 12px;font-weight:800}.locale-picker option{color:var(--ink);background:#fff}.hero-shell{position:relative;overflow:hidden;background:radial-gradient(circle at 82% 20%,rgba(24,183,200,.28),transparent 34%),linear-gradient(135deg,#081322 0,#123a5a 54%,#0b1726 100%);color:#fff}.hero-shell:before{content:"";position:absolute;inset:0;background-image:linear-gradient(115deg,rgba(255,255,255,.08) 0 1px,transparent 1px 84px),linear-gradient(90deg,transparent,rgba(255,255,255,.12),transparent);background-size:86px 86px,100% 100%;pointer-events:none}.hero-grid{position:relative;width:min(1240px,calc(100% - 40px));min-height:650px;margin:0 auto;display:grid;grid-template-columns:minmax(0,1fr) minmax(320px,.78fr);gap:clamp(36px,7vw,96px);align-items:center;padding:96px 0}.eyebrow,.mini{margin:0;color:var(--accent);font-size:11px;font-weight:900;letter-spacing:.14em;text-transform:uppercase}.hero h1{max-width:850px;margin:18px 0 0;font-size:clamp(44px,7vw,86px);line-height:.96;letter-spacing:0;text-wrap:balance}.hero p{max-width:700px;margin:24px 0 0;color:rgba(255,255,255,.78);font-size:18px;line-height:1.75}.hero-actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:32px}.button-link,.add,.submit{display:inline-flex;align-items:center;justify-content:center;min-height:44px;border:1px solid transparent;border-radius:8px;padding:0 18px;background:linear-gradient(135deg,var(--accent),#ffb15f);color:#fff;font-size:12px;font-weight:900;letter-spacing:.08em;text-transform:uppercase;text-decoration:none;cursor:pointer;box-shadow:0 16px 34px rgba(255,107,44,.24);transition:transform .22s cubic-bezier(.2,0,0,1),box-shadow .22s cubic-bezier(.2,0,0,1),background-color .22s cubic-bezier(.2,0,0,1)}.button-link.secondary{border-color:rgba(255,255,255,.32);background:rgba(255,255,255,.08);box-shadow:none}.button-link:hover,.add:hover,.submit:hover{transform:translateY(-2px);box-shadow:0 20px 42px rgba(16,24,32,.22)}.hero-board{position:relative;min-height:500px;border:1px solid rgba(255,255,255,.16);border-radius:8px;background:linear-gradient(145deg,rgba(255,255,255,.14),rgba(255,255,255,.06));box-shadow:24px 24px 0 rgba(255,255,255,.1),0 34px 90px rgba(0,0,0,.28);overflow:hidden}.hero-board:before{content:"";position:absolute;inset:0;background-image:linear-gradient(rgba(255,255,255,.12) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.12) 1px,transparent 1px);background-size:36px 36px;animation:gridMove 16s linear infinite}.preview-card{position:absolute;inset:15% 12%;display:grid;align-content:center;gap:14px;border-radius:8px;background:#fff;color:var(--primary);padding:28px;box-shadow:0 28px 80px rgba(0,0,0,.3);animation:floatCard 5.4s ease-in-out infinite}.preview-card span{display:block;width:70%;height:16px;border-radius:999px;background:#dbe5ed}.preview-card span:nth-child(2){width:54%;background:#eef3f7}.preview-card strong{font-size:clamp(24px,3vw,42px);line-height:1}.live-chip{position:absolute;z-index:3;left:6%;top:8%;display:grid;grid-template-columns:auto 1fr;gap:5px 10px;max-width:280px;border:1px solid rgba(255,255,255,.2);border-radius:8px;background:rgba(255,255,255,.94);color:var(--primary);padding:14px 16px;box-shadow:0 20px 60px rgba(0,0,0,.22)}.live-chip i{grid-row:1/3;width:10px;height:10px;margin-top:4px;border-radius:999px;background:var(--accent);box-shadow:0 0 0 8px rgba(255,107,44,.13);animation:pulse 1.9s ease-in-out infinite}.live-chip strong{font-size:11px;letter-spacing:.08em;text-transform:uppercase}.live-chip small{color:var(--muted);font-weight:700}.signal-strip{border-bottom:1px solid var(--line);background:#fff}.signal-grid{width:min(1240px,calc(100% - 40px));margin:0 auto;display:grid;grid-template-columns:repeat(5,1fr)}.signal-grid span{position:relative;padding:22px 14px;text-align:center;color:var(--primary);font-size:11px;font-weight:900;letter-spacing:.1em;text-transform:uppercase}.signal-grid span:before{content:"";position:absolute;left:50%;top:0;width:40px;height:3px;background:var(--accent);transform:translateX(-50%)}main{width:min(1240px,calc(100% - 40px));margin:0 auto;padding:72px 0 86px}.section-panel{margin-top:28px}.section-head{display:flex;align-items:end;justify-content:space-between;gap:32px;margin-bottom:28px}.section-head h2,main>h2,.request h2{margin:8px 0 0;color:var(--primary);font-size:clamp(32px,4.6vw,56px);line-height:1}.section-head p:not(.eyebrow),.request>p{max-width:640px;margin:0;color:var(--muted);line-height:1.75}.service-grid,.catalog,.gallery-grid,.routing-grid,.proof-grid,.resource-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:22px}.service,.product,.request,.routing-card,.proof-grid article,.resource-grid article{position:relative;overflow:hidden;border:1px solid var(--line);border-radius:8px;background:#fff;box-shadow:0 1px 0 rgba(16,24,32,.04);transition:transform .28s cubic-bezier(.16,1,.3,1),box-shadow .28s cubic-bezier(.16,1,.3,1),border-color .28s cubic-bezier(.16,1,.3,1)}.service:hover,.product:hover,.request:hover,.routing-card:hover,.proof-grid article:hover,.resource-grid article:hover{transform:translateY(-5px);border-color:rgba(255,107,44,.42);box-shadow:0 20px 56px rgba(16,24,32,.12)}.routing-card{display:grid;align-content:start;min-height:220px;padding:24px;color:var(--ink);text-decoration:none}.routing-card span,.proof-grid span{display:grid;place-items:center;width:46px;height:46px;border-radius:8px;background:var(--primary);color:#fff;font-weight:900}.routing-card small{margin-top:18px;color:var(--accent);font-size:11px;font-weight:900;letter-spacing:.1em;text-transform:uppercase}.routing-card strong,.proof-grid strong,.resource-grid h3{display:block;margin-top:10px;color:var(--primary);font-size:22px;line-height:1.12}.routing-card p,.proof-grid p,.resource-grid p{color:var(--muted);line-height:1.65}.proof{padding:34px;border-radius:8px;background:linear-gradient(135deg,var(--dark),var(--primary));color:#fff}.proof .section-head h2{color:#fff}.proof .section-head p{color:rgba(255,255,255,.68)}.proof-grid article{background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.16);padding:20px}.proof-grid strong{color:#fff}.proof-grid p{color:rgba(255,255,255,.68)}.resource-grid article{padding:24px}.service{min-height:220px;padding:26px}.service span{display:grid;place-items:center;width:48px;height:48px;border-radius:8px;background:var(--primary);color:#fff;font-weight:900}.service h3,.product h3{margin:18px 0 0;color:var(--primary);font-size:24px;line-height:1.12}.service p,.product p{color:var(--muted);line-height:1.65}.product-media{position:relative;height:250px;overflow:hidden;background:#e7edf2}.product-media img,.product-placeholder{display:block;width:100%;height:100%;object-fit:cover}.product-placeholder{display:grid;place-items:center;background:linear-gradient(135deg,#eef3f7,#dce8ef);color:var(--muted);font-size:11px;font-weight:900;letter-spacing:.12em;text-transform:uppercase}.product-media b{position:absolute;right:14px;top:14px;display:grid;place-items:center;width:42px;height:42px;border-radius:8px;background:rgba(255,255,255,.93);color:var(--primary);font-size:12px}.product img{transition:transform .42s cubic-bezier(.16,1,.3,1)}.product:hover img{transform:scale(1.045)}.product-body{padding:24px}.product strong{display:block;margin-top:15px;color:var(--primary);font-size:15px}.add,.submit{margin-top:18px;border:0}.add:disabled,.submit:disabled{opacity:.58;cursor:wait}.gallery-grid figure{margin:0}.gallery-grid img{display:block;width:100%;height:240px;object-fit:cover;border-radius:8px;box-shadow:0 16px 42px rgba(16,24,32,.12)}.gallery-grid figcaption{margin-top:9px;color:var(--muted);font-size:13px}.request{padding:28px;background:linear-gradient(180deg,#fff,#f8fbfd)}.request-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px;max-width:850px}.request-grid label{display:grid;gap:8px;color:var(--primary);font-size:11px;font-weight:900;letter-spacing:.08em;text-transform:uppercase}.request-grid input,.request-grid textarea{width:100%;border:1px solid #cbd5df;border-radius:8px;background:#fff;padding:12px;color:var(--ink);font-size:14px;font-weight:500;letter-spacing:0;text-transform:none;outline:none}.request-grid textarea,.request-grid small,.request-grid .submit{grid-column:1/-1}.request-grid input:focus,.request-grid textarea:focus{border-color:var(--accent);box-shadow:0 0 0 4px rgba(255,107,44,.12)}.notice,.cart-lines{min-height:24px;margin-top:14px;color:var(--muted);line-height:1.6}.cart-lines div{padding:8px 0;border-bottom:1px solid var(--line)}.cart-lines strong{display:block;margin-top:10px;color:var(--primary)}.site-footer{border-top:1px solid var(--line);background:var(--dark);color:rgba(255,255,255,.68)}.site-footer-inner{width:min(1240px,calc(100% - 40px));margin:0 auto;display:flex;justify-content:space-between;gap:18px;padding:28px 0;font-size:13px}.empty-message{border:1px dashed var(--line);border-radius:8px;background:#fff;padding:28px;color:var(--muted)}@keyframes gridMove{from{background-position:0 0,0 0}to{background-position:36px 36px,36px 36px}}@keyframes floatCard{0%,100%{transform:translateY(0) rotate(-1deg)}50%{transform:translateY(-10px) rotate(-.35deg)}}@keyframes pulse{0%,100%{box-shadow:0 0 0 7px rgba(255,107,44,.16)}50%{box-shadow:0 0 0 13px rgba(255,107,44,.06)}}@media(max-width:920px){.hero-grid{grid-template-columns:1fr;min-height:auto}.hero-board{min-height:420px}.signal-grid{grid-template-columns:repeat(2,1fr)}.signal-grid span:last-child{grid-column:1/-1}.service-grid,.catalog,.gallery-grid,.routing-grid,.proof-grid,.resource-grid{grid-template-columns:1fr 1fr}.section-head{align-items:flex-start;flex-direction:column}.request-grid{grid-template-columns:1fr}}@media(max-width:620px){.topbar{width:calc(100% - 28px);min-height:68px}.brand strong{max-width:42vw;font-size:12px}.hero-grid,main,.signal-grid,.site-footer-inner{width:calc(100% - 28px)}.hero-grid{padding:58px 0}.hero h1{font-size:38px}.hero-board{min-height:330px;box-shadow:10px 10px 0 rgba(255,255,255,.1)}.preview-card{inset:18% 7% 22%;padding:20px}.live-chip{left:12px;top:12px;max-width:220px;padding:11px 12px}.service-grid,.catalog,.gallery-grid,.routing-grid,.proof-grid,.resource-grid{grid-template-columns:1fr}.product-media{height:220px}.site-footer-inner{flex-direction:column}}@media(prefers-reduced-motion:reduce){*,*:before,*:after{animation-duration:.01ms!important;animation-iteration-count:1!important;scroll-behavior:auto!important;transition-duration:.01ms!important}}`;
    const heroVisual = `<div class="hero-board" aria-hidden="true"><div class="preview-card"><strong>${escapeHtml(ui.products)}</strong><span></span><span></span></div><div class="live-chip"><i></i><strong>${escapeHtml(ui.poweredBy)}</strong><small>${escapeHtml(value.status)}</small></div></div>`;
    const shellOpen = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(profile.globalSeo && typeof profile.globalSeo === 'object' ? (profile.globalSeo as Record<string, unknown>).description : introduction)}"><style>${storefrontStyle}</style></head><body><header class="site-header"><div class="topbar"><div class="brand"><span class="brand-mark">L</span><span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(value.slug)}</small></span></div>${localePicker(locale, ui)}</div></header><section class="hero-shell"><div class="hero-grid"><div class="hero"><p class="eyebrow">${escapeHtml(value.products.length ? ui.shop : ui.services)}</p><h1>${escapeHtml(headline)}</h1><p>${escapeHtml(introduction)}</p><div class="hero-actions"><a class="button-link" href="#request">${escapeHtml(ui.request)}</a><a class="button-link secondary" href="#services">${escapeHtml(ui.services)}</a></div></div>${heroVisual}</div></section>${trustItems.length ? `<section class="signal-strip"><div class="signal-grid">${trustItems.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div></section>` : ''}<main>`;
    const shellClose = `</main><footer class="site-footer"><div class="site-footer-inner"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(ui.poweredBy)} · ${escapeHtml(value.slug)}</span></div></footer>`;
    if (!value.products.length) {
      const html = `${shellOpen}${routingMarkup}${serviceMarkup}${proofMarkup}${assetGallery}${resourceMarkup}<div id="request">${contactMarkup}</div>${shellClose}${contactScript}${localeScript(scriptNonce)}</body></html>`;
      res.setHeader('Content-Security-Policy', `default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`);
      return res.type('html').send(html);
    }
    const html = `${shellOpen}${routingMarkup}${serviceMarkup}<section class="section-panel products" id="products"><div class="section-head"><div><p class="eyebrow">${escapeHtml(ui.shop)}</p><h2>${escapeHtml(ui.products)}</h2></div><p>${escapeHtml(introduction)}</p></div><div class="catalog">${productCards || `<p class="empty-message">${escapeHtml(ui.noProducts)}</p>`}</div></section>${proofMarkup}${assetGallery}${resourceMarkup}<section class="section-panel request" id="request"><div class="section-head"><div><p class="eyebrow">${escapeHtml(ui.request)}</p><h2>${escapeHtml(ui.request)}</h2></div><p>${escapeHtml(ui.requestBody)}</p></div><div id="cart-lines" class="cart-lines">${escapeHtml(ui.noSelection)}</div><form id="request-form" class="request-grid">${requestFieldMarkup}<button class="submit" type="submit">${escapeHtml(ui.send)}</button></form><div id="notice" class="notice" role="status"></div></section>${shellClose}<script nonce="${scriptNonce}">(function(){const slug=${safeScriptJson(value.slug)};const products=${safeScriptJson(publicProducts)};const base='/api/v1/public/storefront/'+encodeURIComponent(slug)+'/';let token=localStorage.getItem('lulu-cart:'+slug)||'';let cart=null;const notice=document.getElementById('notice');const lines=document.getElementById('cart-lines');const show=(text,ok=false)=>{notice.textContent=text;notice.style.color=ok?'#137333':'#b42318'};const call=async(path,options={})=>{const response=await fetch(base+path,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body?.error?.message||body?.message||'${ui.failed}');return body.data;};const ensureCart=async()=>{if(token)return;const created=await call('cart',{method:'POST',body:JSON.stringify({currency:(products.find((item)=>item.currency)||{}).currency||'CNY'})});token=created.token;localStorage.setItem('lulu-cart:'+slug,token)};const render=()=>{if(!cart||!cart.items.length){lines.textContent='${ui.noSelection}';return}lines.innerHTML=cart.items.map((item)=>'<div>'+item.name+' × '+item.quantity+' · '+item.lineTotal+' '+(item.currency||cart.currency)+'</div>').join('')+'<strong>Sum: '+cart.subtotal+' '+cart.currency+'</strong>'};document.querySelectorAll('[data-product-id]').forEach((button)=>button.addEventListener('click',async()=>{button.disabled=true;try{await ensureCart();const result=await call('cart/items',{method:'POST',headers:{'x-lulu-cart-token':token},body:JSON.stringify({token,productId:button.dataset.productId,quantity:'1'})});cart=result.cart;render();show(result.requiresQuote?'${ui.quote}':'${ui.added}',true)}catch(error){show(error.message)}finally{button.disabled=false}}));document.getElementById('request-form').addEventListener('submit',async(event)=>{event.preventDefault();const form=new FormData(event.currentTarget);if(!cart?.items?.length){show('${ui.selectFirst}');return}const button=event.currentTarget.querySelector('button[type=submit]');button.disabled=true;try{await ensureCart();const result=await call('checkout',{method:'POST',headers:{'x-lulu-cart-token':token},body:JSON.stringify({token,email:String(form.get('email')||''),shippingAddress:{note:String(form.get('note')||'')}})});show(result.message||'${ui.requestReceived}',true);event.currentTarget.reset()}catch(error){show(error.message)}finally{button.disabled=false}})})();</script>${localeScript(scriptNonce)}</body></html>`;
    const requestEnhancementScript = `<script nonce="${scriptNonce}">(function(){const slug=${safeScriptJson(value.slug)};const tokenKey='lulu-cart:'+slug;const base='/api/v1/public/storefront/'+encodeURIComponent(slug)+'/';const notice=document.getElementById('notice');const show=(text,ok=false)=>{notice.textContent=text;notice.style.color=ok?'#137333':'#b42318'};const readAttachment=async(file)=>{if(!(file instanceof File)||!file.size)return undefined;if(file.size>5*1024*1024){show('${ui.fileTooLarge}');throw new Error('file-too-large')}const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result||''));reader.onerror=reject;reader.readAsDataURL(file)});return {fileName:file.name,mimeType:file.type||'application/octet-stream',sizeBytes:file.size,dataBase64:String(dataUrl).split(',')[1]||''}};document.getElementById('request-form').addEventListener('submit',async(event)=>{event.preventDefault();event.stopImmediatePropagation();const form=new FormData(event.currentTarget);const token=localStorage.getItem(tokenKey);const button=event.currentTarget.querySelector('button[type=submit]');button.disabled=true;try{if(!token){show('${ui.selectFirst}');return}const cartResponse=await fetch(base+'cart',{headers:{'x-lulu-cart-token':token}});const cartBody=await cartResponse.json().catch(()=>({}));if(!cartResponse.ok||!cartBody?.data?.items?.length){show('${ui.selectFirst}');return}const attachment=await readAttachment(form.get('attachment'));const response=await fetch(base+'checkout',{method:'POST',headers:{'Content-Type':'application/json','x-lulu-cart-token':token},body:JSON.stringify({token,email:String(form.get('email')||''),shippingAddress:{websiteUrl:String(form.get('websiteUrl')||''),whatsappNumber:String(form.get('whatsappNumber')||''),note:String(form.get('note')||''),...(attachment?{attachment}:{})}})});const body=await response.json().catch(()=>({}));if(!response.ok)throw new Error(body?.error?.message||'${ui.failed}');show(body?.data?.message||'${ui.requestReceived}',true);event.currentTarget.reset()}catch(error){if(error.message!=='file-too-large')show(error.message||'${ui.failed}')}finally{button.disabled=false}},true)})();</script>`;
    const renderedHtml = html.replace('</body>', `${requestEnhancementScript}</body>`);
    res.setHeader('Content-Security-Policy', `default-src 'none'; img-src https: data:; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`);
    return res.type('html').send(renderedHtml);
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
