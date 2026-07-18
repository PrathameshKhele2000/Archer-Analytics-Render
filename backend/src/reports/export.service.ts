import { Injectable } from "@nestjs/common";
import { Response } from "express";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";

export interface ExportColumn {
  key: string;
  label: string;
}

const PDF_ROW_LIMIT = 2000;

@Injectable()
export class ExportService {
  /** Streams rows to an .xlsx file with constant memory via ExcelJS's streaming writer. */
  async streamExcel(
    res: Response,
    filename: string,
    columns: ExportColumn[],
    rows: AsyncIterable<Record<string, unknown>[]>,
  ): Promise<void> {
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", `attachment; filename=${filename}`);

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true });
    const sheet = workbook.addWorksheet("Data");
    sheet.columns = columns.map((c) => ({ header: c.label, key: c.key, width: 22 }));
    sheet.getRow(1).font = { bold: true };

    for await (const batch of rows) {
      for (const row of batch) {
        sheet.addRow(row).commit();
      }
    }
    sheet.commit();
    await workbook.commit();
  }

  /**
   * Streams a simple tabular PDF (header + rows), capped at PDF_ROW_LIMIT rows —
   * PDF is meant for a printable/shareable snapshot, not bulk export (use Excel/CSV for that).
   */
  async streamPdf(
    res: Response,
    filename: string,
    title: string,
    columns: ExportColumn[],
    rows: AsyncIterable<Record<string, unknown>[]>,
  ): Promise<void> {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename=${filename}`);

    const doc = new PDFDocument({ margin: 30, size: "A4", layout: "landscape" });
    doc.pipe(res);

    doc.fontSize(16).text(title, { align: "left" });
    doc.moveDown(0.5);
    doc.fontSize(8);

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const colWidth = pageWidth / columns.length;
    const rowHeight = 16;

    const drawHeader = () => {
      let x = doc.page.margins.left;
      const y = doc.y;
      doc.font("Helvetica-Bold");
      for (const col of columns) {
        doc.text(col.label, x, y, { width: colWidth - 4, ellipsis: true });
        x += colWidth;
      }
      doc.font("Helvetica");
      doc.moveDown(1);
    };

    drawHeader();
    let printed = 0;
    let truncated = false;

    outer: for await (const batch of rows) {
      for (const row of batch) {
        if (printed >= PDF_ROW_LIMIT) {
          truncated = true;
          break outer;
        }
        if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom) {
          doc.addPage();
          drawHeader();
        }
        let x = doc.page.margins.left;
        const y = doc.y;
        for (const col of columns) {
          const value = row[col.key];
          doc.text(value === null || value === undefined ? "" : String(value), x, y, {
            width: colWidth - 4,
            ellipsis: true,
          });
          x += colWidth;
        }
        doc.moveDown(1);
        printed++;
      }
    }

    if (truncated) {
      doc.moveDown(1);
      doc
        .fontSize(9)
        .fillColor("red")
        .text(`Showing first ${PDF_ROW_LIMIT.toLocaleString()} rows. Use the Excel or CSV export for the full data set.`);
    }

    doc.end();
  }
}
