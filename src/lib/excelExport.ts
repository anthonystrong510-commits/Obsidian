import type { EmergencySweepRecord } from '../types/wallet';

/**
 * Neutralizes spreadsheet formula injection (CSV/Excel DDE & formula execution):
 * prefixes any string starting with =, +, -, @, \t, or \r (even after leading spaces) with `'`.
 */
export function sanitizeSpreadsheetCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value).replace(/\r\n/g, ' ').replace(/[\r\n]/g, ' ');
  const trimmedStart = str.replace(/^\s+/, '');
  if (/^[=+\-@\t]/.test(str) || /^[=+\-@\t]/.test(trimmedStart)) {
    return `'${str}`;
  }
  return str;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function escapeCsvCell(value: unknown): string {
  const safe = sanitizeSpreadsheetCell(value);
  if (/[",\n\r]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

function formatIsoDate(ms?: number): string {
  if (!ms || !Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toISOString();
  } catch {
    return '';
  }
}

export function downloadEmergencySweepsCsv(
  records: EmergencySweepRecord[],
  filenamePrefix = 'obsidian-emergency-sweeps'
): void {
  const headers = [
    'Sweep ID',
    'Batch ID',
    'Mode',
    'User UID',
    'User Display Name',
    'User Email',
    'Swept Wallet Count',
    'Swept Wallet IDs',
    'Swept Addresses',
    'Swept Assets Summary',
    'Swept USD Value',
    'Emergency Destination Wallet',
    'Emergency Destination Address',
    'Reason',
    'New Replacement Wallet ID',
    'New Replacement Wallet Name',
    'New Replacement EVM Address',
    'New Replacement Solana Address',
    'New Replacement Bitcoin Address',
    'Reimbursement Status',
    'Reimbursed Coins Summary',
    'Reimbursed USD Value',
    'Reimbursement Claim ID',
    'Reimbursement Tx Reference',
    'Performed By Admin UID',
    'Swept At (UTC)',
    'Reimbursed At (UTC)',
  ];

  const rows = records.map((r) => [
    r.id,
    r.batchId,
    r.mode === 'bulk_all' ? 'Bulk All Users' : 'Selected Users',
    r.targetUid,
    r.targetDisplayName,
    r.targetEmail,
    String(r.sweptWalletIds.length),
    r.sweptWalletIds.join(' | '),
    r.sweptAddressesSummary,
    r.sweptAssetsSummary,
    Number(r.sweptUsdValue || 0).toFixed(2),
    r.destinationWalletLabel,
    r.destinationAddress,
    r.reason,
    r.replacementWalletId,
    r.replacementWalletName,
    r.replacementEvmAddress || '',
    r.replacementSolanaAddress || '',
    r.replacementBitcoinAddress || '',
    r.reimbursementStatus === 'reimbursed' ? 'Reimbursed' : 'Pending Reimbursement',
    r.reimbursedAmountSummary,
    Number(r.reimbursedUsdValue || 0).toFixed(2),
    r.reimbursedClaimId || '',
    r.reimbursedTxHash || '',
    r.performedBy,
    formatIsoDate(r.createdAt),
    formatIsoDate(r.reimbursedAt),
  ]);

  const csvContent =
    '\uFEFF' +
    [headers.map(escapeCsvCell).join(','), ...rows.map((row) => row.map(escapeCsvCell).join(','))].join(
      '\r\n'
    );

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  triggerBrowserDownload(blob, `${filenamePrefix}-${new Date().toISOString().slice(0, 10)}.csv`);
}

/**
 * Generates a native Excel SpreadsheetML 2003 (.xls) multi-worksheet workbook
 * without external binary/XLSX parser vulnerabilities. Opens cleanly in Microsoft Excel,
 * LibreOffice Calc, and Google Sheets.
 */
export function downloadEmergencySweepsExcel(
  records: EmergencySweepRecord[],
  filenamePrefix = 'obsidian-emergency-sweeps'
): void {
  const headers = [
    'Sweep ID',
    'Batch ID',
    'Sweep Mode',
    'User UID',
    'User Name',
    'User Email',
    'Swept Wallets',
    'Swept Wallet IDs',
    'Swept Addresses',
    'Swept Assets',
    'Swept USD',
    'Emergency Cold Wallet',
    'Destination Address',
    'Incident Reason',
    'New Wallet ID',
    'New Wallet Name',
    'New EVM Address',
    'New Solana Address',
    'New Bitcoin Address',
    'Reimbursement Status',
    'Reimbursed Coins',
    'Reimbursed USD',
    'Claim ID',
    'Reimbursement Tx Hash',
    'Admin UID',
    'Swept Timestamp (UTC)',
    'Reimbursed Timestamp (UTC)',
  ];

  const renderCell = (value: string | number, type: 'String' | 'Number' = 'String', style = 'Cell') => {
    const clean = type === 'Number' ? String(Number(value) || 0) : escapeXml(sanitizeSpreadsheetCell(value));
    return `<Cell ss:StyleID="${style}"><Data ss:Type="${type}">${clean}</Data></Cell>`;
  };

  const detailRowsXml = records
    .map((r) => {
      const cells = [
        renderCell(r.id),
        renderCell(r.batchId),
        renderCell(r.mode === 'bulk_all' ? 'Bulk All Users' : 'Selected Users'),
        renderCell(r.targetUid),
        renderCell(r.targetDisplayName),
        renderCell(r.targetEmail),
        renderCell(r.sweptWalletIds.length, 'Number'),
        renderCell(r.sweptWalletIds.join(' | ')),
        renderCell(r.sweptAddressesSummary),
        renderCell(r.sweptAssetsSummary),
        renderCell(Number(r.sweptUsdValue || 0).toFixed(2), 'Number', 'Currency'),
        renderCell(r.destinationWalletLabel),
        renderCell(r.destinationAddress),
        renderCell(r.reason),
        renderCell(r.replacementWalletId),
        renderCell(r.replacementWalletName),
        renderCell(r.replacementEvmAddress || ''),
        renderCell(r.replacementSolanaAddress || ''),
        renderCell(r.replacementBitcoinAddress || ''),
        renderCell(r.reimbursementStatus === 'reimbursed' ? 'Reimbursed' : 'Pending Reimbursement'),
        renderCell(r.reimbursedAmountSummary),
        renderCell(Number(r.reimbursedUsdValue || 0).toFixed(2), 'Number', 'Currency'),
        renderCell(r.reimbursedClaimId || ''),
        renderCell(r.reimbursedTxHash || ''),
        renderCell(r.performedBy),
        renderCell(formatIsoDate(r.createdAt)),
        renderCell(formatIsoDate(r.reimbursedAt)),
      ];
      return `<Row>${cells.join('')}</Row>`;
    })
    .join('\n');

  const totalSweptUsd = records.reduce((s, r) => s + Number(r.sweptUsdValue || 0), 0);
  const totalReimbursedUsd = records
    .filter((r) => r.reimbursementStatus === 'reimbursed')
    .reduce((s, r) => s + Number(r.reimbursedUsdValue || 0), 0);
  const reimbursedCount = records.filter((r) => r.reimbursementStatus === 'reimbursed').length;
  const pendingCount = records.length - reimbursedCount;

  const summaryRows = [
    ['Report Generated (UTC)', new Date().toISOString()],
    ['Total Emergency Sweep Records', records.length],
    ['Unique Users Affected', new Set(records.map((r) => r.targetUid)).size],
    ['Total Swept USD Value', totalSweptUsd.toFixed(2)],
    ['Reimbursed Users Count', reimbursedCount],
    ['Pending Reimbursement Count', pendingCount],
    ['Total Reimbursed USD Value', totalReimbursedUsd.toFixed(2)],
  ];

  const summaryRowsXml = summaryRows
    .map(([k, v]) => {
      const isNum = typeof v === 'number';
      return `<Row>${renderCell(k, 'String', 'Header')}${renderCell(
        v,
        isNum ? 'Number' : 'String',
        'Cell'
      )}</Row>`;
    })
    .join('\n');

  const workbookXml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="Default" ss:Name="Normal">
   <Font ss:FontName="Calibri" ss:Size="11"/>
  </Style>
  <Style ss:ID="Header">
   <Font ss:FontName="Calibri" ss:Size="11" ss:Bold="1" ss:Color="#FFFFFF"/>
   <Interior ss:Color="#0F172A" ss:Pattern="Solid"/>
  </Style>
  <Style ss:ID="Cell">
   <Font ss:FontName="Calibri" ss:Size="10"/>
  </Style>
  <Style ss:ID="Currency">
   <Font ss:FontName="Calibri" ss:Size="10"/>
   <NumberFormat ss:Format="#,##0.00"/>
  </Style>
 </Styles>
 <Worksheet ss:Name="Emergency_Sweeps">
  <Table>
   <Row>${headers.map((h) => renderCell(h, 'String', 'Header')).join('')}</Row>
   ${detailRowsXml}
  </Table>
 </Worksheet>
 <Worksheet ss:Name="Summary">
  <Table>
   ${summaryRowsXml}
  </Table>
 </Worksheet>
</Workbook>`;

  const blob = new Blob([workbookXml], {
    type: 'application/vnd.ms-excel;charset=utf-8;',
  });
  triggerBrowserDownload(blob, `${filenamePrefix}-${new Date().toISOString().slice(0, 10)}.xls`);
}

function triggerBrowserDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
