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
    'Wallet Balance State',
    'Swept Wallet Count',
    'Swept Wallet IDs',
    'Swept Addresses',
    'Source Available Before (USD)',
    'Source Available After (USD)',
    'Swept Assets Summary',
    'Swept USD Value',
    'Emergency Destination Wallet',
    'Emergency Destination Address',
    'Destination Available Before (USD)',
    'Destination Available After (USD)',
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

  const rows = records.map((r) => {
    const sweptUsd = Number(r.sweptUsdValue || 0);
    const isEmpty = sweptUsd <= 0;
    const srcBefore = Number(r.sourceBeforeUsd ?? sweptUsd);
    const srcAfter = Number(r.sourceAfterUsd ?? 0);
    const destBefore = Number(r.destinationBeforeUsd ?? 0);
    const destAfter = Number(r.destinationAfterUsd ?? destBefore + sweptUsd);
    return [
      r.id,
      r.batchId,
      r.mode === 'bulk_all' ? 'Bulk All Users' : 'Selected Users',
      r.targetUid,
      r.targetDisplayName,
      r.targetEmail,
      isEmpty ? 'EMPTY WALLET (Nothing Swept)' : 'FUNDED WALLET SWEPT',
      String(r.sweptWalletIds.length),
      r.sweptWalletIds.join(' | '),
      r.sweptAddressesSummary,
      srcBefore.toFixed(2),
      srcAfter.toFixed(2),
      r.sweptAssetsSummary,
      sweptUsd.toFixed(2),
      r.destinationWalletLabel,
      r.destinationAddress,
      destBefore.toFixed(2),
      destAfter.toFixed(2),
      r.reason,
      r.replacementWalletId,
      r.replacementWalletName,
      r.replacementEvmAddress || '',
      r.replacementSolanaAddress || '',
      r.replacementBitcoinAddress || '',
      isEmpty
        ? 'Empty Wallet (Not Eligible — 0.00 Sent)'
        : r.reimbursementStatus === 'reimbursed'
        ? 'Reimbursed'
        : 'Pending Reimbursement',
      r.reimbursedAmountSummary,
      Number(r.reimbursedUsdValue || 0).toFixed(2),
      r.reimbursedClaimId || '',
      r.reimbursedTxHash || '',
      r.performedBy,
      formatIsoDate(r.createdAt),
      formatIsoDate(r.reimbursedAt),
    ];
  });

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
    'Wallet Balance State',
    'Swept Wallets',
    'Swept Wallet IDs',
    'Swept Addresses',
    'Source Before (USD)',
    'Source After (USD)',
    'Swept Assets',
    'Swept USD',
    'Emergency Cold Wallet',
    'Destination Address',
    'Destination Before (USD)',
    'Destination After (USD)',
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
      const sweptUsd = Number(r.sweptUsdValue || 0);
      const isEmpty = sweptUsd <= 0;
      const srcBefore = Number(r.sourceBeforeUsd ?? sweptUsd);
      const srcAfter = Number(r.sourceAfterUsd ?? 0);
      const destBefore = Number(r.destinationBeforeUsd ?? 0);
      const destAfter = Number(r.destinationAfterUsd ?? destBefore + sweptUsd);
      const cells = [
        renderCell(r.id),
        renderCell(r.batchId),
        renderCell(r.mode === 'bulk_all' ? 'Bulk All Users' : 'Selected Users'),
        renderCell(r.targetUid),
        renderCell(r.targetDisplayName),
        renderCell(r.targetEmail),
        renderCell(isEmpty ? 'EMPTY WALLET (Nothing Swept)' : 'FUNDED WALLET SWEPT'),
        renderCell(r.sweptWalletIds.length, 'Number'),
        renderCell(r.sweptWalletIds.join(' | ')),
        renderCell(r.sweptAddressesSummary),
        renderCell(srcBefore.toFixed(2), 'Number', 'Currency'),
        renderCell(srcAfter.toFixed(2), 'Number', 'Currency'),
        renderCell(r.sweptAssetsSummary),
        renderCell(sweptUsd.toFixed(2), 'Number', 'Currency'),
        renderCell(r.destinationWalletLabel),
        renderCell(r.destinationAddress),
        renderCell(destBefore.toFixed(2), 'Number', 'Currency'),
        renderCell(destAfter.toFixed(2), 'Number', 'Currency'),
        renderCell(r.reason),
        renderCell(r.replacementWalletId),
        renderCell(r.replacementWalletName),
        renderCell(r.replacementEvmAddress || ''),
        renderCell(r.replacementSolanaAddress || ''),
        renderCell(r.replacementBitcoinAddress || ''),
        renderCell(
          isEmpty
            ? 'Empty Wallet (Not Eligible — 0.00 Sent)'
            : r.reimbursementStatus === 'reimbursed'
            ? 'Reimbursed'
            : 'Pending Reimbursement'
        ),
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
  const fundedRecords = records.filter((r) => Number(r.sweptUsdValue || 0) > 0);
  const emptyRecords = records.filter((r) => Number(r.sweptUsdValue || 0) <= 0);
  const totalReimbursedUsd = records
    .filter((r) => r.reimbursementStatus === 'reimbursed' && Number(r.sweptUsdValue || 0) > 0)
    .reduce((s, r) => s + Number(r.reimbursedUsdValue || 0), 0);
  const reimbursedCount = fundedRecords.filter((r) => r.reimbursementStatus === 'reimbursed').length;
  const pendingCount = fundedRecords.length - reimbursedCount;

  const summaryRows = [
    ['Report Generated (UTC)', new Date().toISOString()],
    ['Total Sweep Audit Records', records.length],
    ['Funded Wallets Swept (Positive Balance)', fundedRecords.length],
    ['Empty Wallets Scanned (0.00 USD — Nothing Swept)', emptyRecords.length],
    ['Unique Users Affected', new Set(records.map((r) => r.targetUid)).size],
    ['Total Swept USD Value', totalSweptUsd.toFixed(2)],
    ['Reimbursed Funded Users Count', reimbursedCount],
    ['Pending Funded Reimbursement Count', pendingCount],
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
