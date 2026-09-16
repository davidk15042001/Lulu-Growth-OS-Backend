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

/** Render a deterministic, print-ready invoice PDF from the canonical invoice snapshot. */
export function renderInvoicePdf(detail: InvoicePdfDetail): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const invoice = detail.invoice;
    const seller = detail.sellerProfile;
    const currency = text(invoice.currency, 'CNY');
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
    document.fillColor('#111827').font('Helvetica-Bold').fontSize(13).text(text(seller?.companyName, 'Lulu AI'), right - 210, 50, { width: 210, align: 'right' });
    document.fillColor('#5b6578').font('Helvetica').fontSize(9).text([seller?.address, seller?.countryRegion, seller?.phoneNumber].filter(Boolean).map(String).join(' · ') || 'Digital company platform', right - 260, 70, { width: 260, align: 'right' });
    drawRule(document, 104);

    document.fillColor('#6b7280').fontSize(8).text('BILL TO', left, 125);
    document.fillColor('#111827').font('Helvetica-Bold').fontSize(10).text(`Workspace ${text(invoice.customerRecordId)}`, left, 141, { width: 220 });
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
