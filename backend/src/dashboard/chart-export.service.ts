import { Injectable } from "@nestjs/common";
import { Response } from "express";
import PDFDocument from "pdfkit";
import ExcelJS from "exceljs";

export interface ChartExportPayload {
  title: string;
  caption?: string;
  headers: string[];
  rows: (string | number | null)[][];
  image?: string; // data URL (image/png) of the rendered chart, for PDF
}

const safeName = (s: string) => (s || "chart").replace(/[^a-z0-9_-]+/gi, "_").slice(0, 60);

@Injectable()
export class ChartExportService {
  /** Excel workbook of the chart's tabular data. */
  async excel(res: Response, p: ChartExportPayload) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Chart data");
    ws.addRow(p.headers);
    ws.getRow(1).font = { bold: true };
    for (const r of p.rows) ws.addRow(r);
    ws.columns.forEach((col) => {
      let max = 10;
      col.eachCell?.({ includeEmpty: true }, (cell) => {
        max = Math.max(max, String(cell.value ?? "").length + 2);
      });
      col.width = Math.min(48, max);
    });
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName(p.title)}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  }

  /** PDF with the rendered chart image followed by its data table. */
  async pdf(res: Response, p: ChartExportPayload) {
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${safeName(p.title)}.pdf"`);
    doc.pipe(res);

    const left = doc.page.margins.left;
    const usable = doc.page.width - left - doc.page.margins.right;

    doc.fontSize(16).fillColor("#111").text(p.title, left, doc.y);
    if (p.caption) doc.moveDown(0.2).fontSize(10).fillColor("#666").text(p.caption);
    doc.fillColor("#000").moveDown(0.8);

    // --- Chart image at the top (reserve a fixed block so the table never overlaps) ---
    if (p.image?.startsWith("data:image")) {
      try {
        const b64 = p.image.split(",")[1];
        const imgTop = doc.y;
        const imgH = 300;
        doc.image(Buffer.from(b64, "base64"), left, imgTop, { fit: [usable, imgH], align: "center" });
        doc.y = imgTop + imgH + 20; // move the cursor firmly below the image block
      } catch {
        /* skip bad image */
      }
    }

    // --- Data table below the chart ---
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#111").text("Data", left, doc.y);
    doc.moveDown(0.4).fillColor("#000");
    const colW = usable / Math.max(1, p.headers.length);
    const rowH = 18;

    const drawRow = (cells: (string | number | null)[], y: number, bold = false) => {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(9).fillColor("#000");
      cells.forEach((c, i) => {
        doc.text(String(c ?? ""), left + i * colW + 2, y + 4, { width: colW - 4, ellipsis: true, lineBreak: false });
      });
    };

    doc.moveDown(0.5);
    let y = doc.y;
    drawRow(p.headers, y, true);
    doc.moveTo(left, y + rowH - 2).lineTo(left + usable, y + rowH - 2).strokeColor("#ccc").stroke();
    y += rowH;

    for (const r of p.rows.slice(0, 1000)) {
      if (y + rowH > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        y = doc.page.margins.top;
      }
      drawRow(r, y);
      y += rowH;
    }
    doc.end();
  }
}
