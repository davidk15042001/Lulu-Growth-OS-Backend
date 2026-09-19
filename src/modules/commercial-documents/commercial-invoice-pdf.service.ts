import PDFDocument from 'pdfkit';
import type { DocumentSellerProfile } from './commercial-documents.repo.js';

type PdfLine = {
  productName?: unknown;
  description?: unknown;
  quantity?: unknown;
  quantityUnit?: unknown;
  unitPrice?: unknown;
  discount?: unknown;
  tax?: unknown;
  lineTotal?: unknown;
};

type PdfInvoice = {
  invoiceNumber?: unknown;
  invoiceType?: unknown;
  status?: unknown;
  currency?: unknown;
  language?: unknown;
  customerRecordId?: unknown;
  issueDate?: unknown;
  dueDate?: unknown;
  subtotal?: unknown;
  discountTotal?: unknown;
  shippingTotal?: unknown;
  taxTotal?: unknown;
  grandTotal?: unknown;
  amountPaid?: unknown;
  amountDue?: unknown;
  createdAt?: unknown;
};

export type InvoicePdfDetail = {
  invoice: PdfInvoice;
  sellerProfile: DocumentSellerProfile | null;
  buyerProfile?: DocumentSellerProfile | null;
  lines: PdfLine[];
};

const text = (value: unknown, fallback = '—') => {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
};

const number = (value: unknown) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

function formatMoney(value: unknown, currency: string) {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(number(value));
  } catch {
    return `${number(value).toFixed(2)} ${currency}`;
  }
}

function formatDate(value: unknown) {
  if (!value) return '—';
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString('en-GB');
}

function drawRule(doc: PDFKit.PDFDocument, y: number) {
  doc.moveTo(48, y).lineTo(547, y).strokeColor('#d8deea').stroke();
}

/**
 * Resolve a seller logo without making PDF generation dependent on storage or
 * an image CDN. A failed/unsupported image is intentionally ignored; the
 * legal seller text remains in the document.
 */
async function loadSellerLogo(seller: DocumentSellerProfile | null): Promise<Buffer | null> {
  const configured = String(seller?.logoUrl ?? '').trim();
  const fallback = seller?.companyName?.trim().toLowerCase() === 'lulu ai'
    ? 'https://lulu-ai.cn/branding/lulu-agentic-logo.png'
    : '';
  const source = configured || fallback;
  if (!source) return null;
  try {
    if (source.startsWith('data:image/png;base64,')) return Buffer.from(source.slice('data:image/png;base64,'.length), 'base64');
    if (source.startsWith('data:image/jpeg;base64,')) return Buffer.from(source.slice('data:image/jpeg;base64,'.length), 'base64');
    if (!/^https?:\/\//i.test(source)) return null;
    const response = await fetch(source, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    // PDFKit does not decode WebP/SVG directly. Keep the invoice reliable and
    // let the seller text render when the uploaded format is unsupported.
    if (contentType && !contentType.includes('png') && !contentType.includes('jpeg') && !contentType.includes('jpg')) return null;
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return null;
  }
}

/** Render a deterministic, print-ready invoice PDF from the canonical invoice snapshot. */
export function renderInvoicePdf(detail: InvoicePdfDetail): Promise<Buffer> {
  return new Promise(async (resolve, reject) => {
    const invoice = detail.invoice;
    const seller = detail.sellerProfile;
    const buyer = detail.buyerProfile ?? null;
    const currency = text(invoice.currency, 'CNY');
    const sellerLogo = await loadSellerLogo(seller);
    const document = new PDFDocument({ size: 'A4', margin: 48, info: {
      Title: `Invoice ${text(invoice.invoiceNumber)}`,
      Author: seller?.companyName ?? 'Lulu AI',
      Subject: 'Commercial invoice',
    } });
    const chunks: Buffer[] = [];
    document.on('data', (chunk: Buffer | Uint8Array) => chunks.push(Buffer.from(chunk)));
    document.on('error', reject);
    document.on('end', () => resolve(Buffer.concat(chunks)));

    const left = 48;
    const right = 547;
    document.fillColor('#111827').font('Helvetica-Bold').fontSize(24).text('INVOICE', left, 48);
    document.fillColor('#4f46e5').fontSize(10).text(text(invoice.invoiceNumber), left, 80);
    const sellerTextWidth = sellerLogo ? 155 : 210;
    const sellerTextX = right - sellerTextWidth;
    if (sellerLogo) {
      try { document.image(sellerLogo, right - 62, 45, { fit: [52, 42], align: 'center', valign: 'center' }); } catch { /* unsupported/corrupt image; text still renders */ }
    }
    document.fillColor('#111827').font('Helvetica-Bold').fontSize(13).text(text(seller?.companyName, 'Lulu AI'), sellerTextX, 50, { width: sellerTextWidth, align: 'right' });
    const sellerDetails = [
      seller?.address ? `Address: ${seller.address}` : null,
      seller?.countryRegion ? `Country: ${seller.countryRegion}` : null,
      seller?.taxId ? `Tax ID: ${seller.taxId}` : null,
      seller?.legalForm ? `Legal form: ${seller.legalForm}` : null,
      seller?.legalRepresentative ? `Representative: ${seller.legalRepresentative}` : null,
      seller?.phoneNumber ? `Phone: ${seller.phoneNumber}` : null,
      seller?.bankAccountNumber ? `Bank account: ${seller.bankAccountNumber}` : null,
      seller?.bankOpeningBank ? `Bank: ${seller.bankOpeningBank}` : null,
    ].filter((value): value is string => Boolean(value));
    document.fillColor('#5b6578').font('Helvetica').fontSize(8).text(sellerDetails.join('\n') || 'Digital company platform', sellerTextX, 70, { width: sellerTextWidth, align: 'right', lineGap: 1 });
    drawRule(document, 104);

    document.fillColor('#6b7280').fontSize(8).text('BILL TO', left, 125);
    document.fillColor('#111827').font('Helvetica-Bold').fontSize(10).text(
      text(buyer?.companyName, invoice.customerRecordId ? `Customer record ${text(invoice.customerRecordId)}` : 'Customer workspace'),
      left,
      141,
      { width: 220 },
    );
    const buyerContact = [buyer?.address, buyer?.countryRegion, buyer?.phoneNumber].filter(Boolean).map(String).join(' · ');
    if (buyerContact) document.fillColor('#5b6578').font('Helvetica').fontSize(8).text(buyerContact, left, 157, { width: 220 });
    document.fillColor('#6b7280').font('Helvetica').fontSize(9).text('Invoice details', 330, 125);
    document.fillColor('#111827').fontSize(9)
      .text(`Status: ${text(invoice.status)}`, 330, 141)
      .text(`Issue date: ${formatDate(invoice.issueDate)}`, 330, 155)
      .text(`Due date: ${formatDate(invoice.dueDate)}`, 330, 169);

    let y = 215;
    document.fillColor('#eef2ff').rect(left, y, right - left, 27).fill();
    document.fillColor('#3730a3').font('Helvetica-Bold').fontSize(8)
      .text('DESCRIPTION', left + 10, y + 9)
      .text('QTY', 345, y + 9, { width: 35, align: 'right' })
      .text('UNIT', 390, y + 9, { width: 65, align: 'right' })
      .text('TOTAL', 470, y + 9, { width: 67, align: 'right' });
    y += 40;

    document.font('Helvetica').fontSize(9);
    for (const line of detail.lines) {
      const name = text(line.productName, 'Line item');
      const description = line.description ? String(line.description) : '';
      const rowHeight = description ? 34 : 23;
      if (y + rowHeight > 730) {
        document.addPage();
        y = 56;
      }
      document.fillColor('#111827').font('Helvetica-Bold').text(name, left + 10, y, { width: 280 });
      if (description) document.fillColor('#6b7280').font('Helvetica').fontSize(8).text(description, left + 10, y + 13, { width: 280, ellipsis: true });
      document.fillColor('#374151').font('Helvetica').fontSize(9)
        .text(text(line.quantity, '0'), 345, y, { width: 35, align: 'right' })
        .text(formatMoney(line.unitPrice, currency), 390, y, { width: 65, align: 'right' })
        .text(formatMoney(line.lineTotal, currency), 470, y, { width: 67, align: 'right' });
      drawRule(document, y + rowHeight - 6);
      y += rowHeight;
    }
    if (detail.lines.length === 0) {
      document.fillColor('#6b7280').font('Helvetica').text('No line items recorded.', left + 10, y);
      y += 24;
    }

    y = Math.max(y + 18, 470);
    const totalX = 340;
    const totalRow = (label: string, value: unknown, bold = false) => {
      document.fillColor(bold ? '#111827' : '#5b6578').font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9)
        .text(label, totalX, y, { width: 110 })
        .text(formatMoney(value, currency), 470, y, { width: 67, align: 'right' });
      y += bold ? 24 : 18;
    };
    totalRow('Subtotal', invoice.subtotal);
    totalRow('Discount', invoice.discountTotal);
    totalRow('Shipping', invoice.shippingTotal);
    totalRow('Tax', invoice.taxTotal);
    drawRule(document, y - 7);
    y += 7;
    totalRow('TOTAL', invoice.grandTotal, true);
    totalRow('Paid', invoice.amountPaid);
    totalRow('Amount due', invoice.amountDue, true);

    document.fillColor('#6b7280').font('Helvetica').fontSize(8).text(`Generated by Lulu AI · ${new Date().toLocaleDateString('en-GB')}`, left, 765, { width: 499, align: 'center' });
    document.end();
  });
}
