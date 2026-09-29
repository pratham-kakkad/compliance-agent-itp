import { useCallback, useRef, useState } from "react";
import clsx from "clsx";
import { motion } from "framer-motion";
import { CheckCircle2, Download, FileSpreadsheet, Rows3, UploadCloud, Users, X, XCircle } from "lucide-react";
import { uploadFile } from "../lib/api";
import { fmtBytes } from "../lib/format";
import type { AttendanceImportResult } from "../types";
import { Banner, Button, Card, CardHeader, DataTable, EmptyState, IconButton, PageHeader, ProgressBar, StatCard } from "../components/ui";
import { notify } from "../components/shell/toast";

const ACCEPTED_EXT = [".csv", ".xlsx", ".xlsm"];
const COLUMNS = ["Log Date", "Device", "Emp Code", "Name", "Company", "Department"];

function hasAcceptedExtension(filename: string): boolean {
  const lower = filename.toLowerCase();
  return ACCEPTED_EXT.some((ext) => lower.endsWith(ext));
}

function downloadTemplate() {
  const rows = [
    COLUMNS.join(","),
    "22-09-2026 09:02,Entry,EMP001,Jane Doe,Acme Corp,Engineering",
    "22-09-2026 18:07,Exit,EMP001,Jane Doe,Acme Corp,Engineering",
  ];
  const url = URL.createObjectURL(new Blob([rows.join("\n") + "\n"], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "punch-log-template.csv";
  a.click();
  URL.revokeObjectURL(url);
}

export function AttendanceImport() {
  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<AttendanceImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const chooseFile = useCallback((f: File | null) => {
    setResult(null);
    setError(null);
    if (inputRef.current) inputRef.current.value = "";
    if (f && !hasAcceptedExtension(f.name)) {
      setFile(null);
      setError(`"${f.name}" isn't a .csv or .xlsx punch-log export.`);
      return;
    }
    setFile(f);
  }, []);

  const submit = async () => {
    if (!file) return;
    setUploading(true);
    setError(null);
    setResult(null);
    try {
      const r = await uploadFile<AttendanceImportResult>("/attendance/import", file);
      setResult(r);
      setFile(null);
      notify.success("Import complete", `${r.accepted} of ${r.row_count} rows accepted${r.rejected.length ? `, ${r.rejected.length} rejected` : ""}.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Upload failed.";
      setError(msg);
      notify.error("Import failed", msg);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Import punch logs"
        description="Upload a biometric device export to recompute tracked attendance"
        actions={<Button leadingIcon={Download} onClick={downloadTemplate}>Download template</Button>}
      />

      <div className="grid lg:grid-cols-3 gap-4 items-start">
        <Card className="lg:col-span-2">
          <div
            role="button"
            tabIndex={0}
            aria-label="Choose a punch-log file to import"
            onClick={() => inputRef.current?.click()}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                inputRef.current?.click();
              }
            }}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              chooseFile(e.dataTransfer.files?.[0] ?? null);
            }}
            className={clsx(
              "flex flex-col items-center justify-center gap-3 text-center rounded-xl border-2 border-dashed cursor-pointer px-6 py-12 transition-colors duration-150",
              dragging ? "border-accent bg-accent-soft" : error ? "border-crit bg-crit-bg" : "border-line hover:border-line-strong hover:bg-panel2"
            )}
          >
            <input ref={inputRef} type="file" accept=".csv,.xlsx,.xlsm" className="hidden" onChange={(e) => chooseFile(e.target.files?.[0] ?? null)} />
            <motion.span
              animate={{ y: dragging ? -4 : 0, scale: dragging ? 1.06 : 1 }}
              transition={{ type: "spring", stiffness: 500, damping: 30 }}
              className={clsx("w-12 h-12 rounded-full flex items-center justify-center border", dragging ? "bg-panel border-accent text-accent" : "bg-panel2 border-line text-ink2")}
            >
              <UploadCloud size={22} aria-hidden />
            </motion.span>
            <div>
              <p className="text-sm font-semibold text-ink">
                {dragging ? "Drop to add the file" : <>Drag a file here, or <span className="text-accent">browse</span></>}
              </p>
              <p className="text-[13px] text-ink2 mt-1">.csv, .xlsx or .xlsm exports from the biometric device</p>
            </div>
          </div>

          {error && (
            <Banner tone="crit" className="mt-4" onDismiss={() => setError(null)}>
              {error}
            </Banner>
          )}

          {file && (
            <div className="mt-4 flex items-center gap-3 rounded-lg border border-line bg-panel2 px-3 py-2.5">
              <FileSpreadsheet size={20} className="text-good flex-none" aria-hidden />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-ink truncate">{file.name}</div>
                <div className="text-xs text-ink2">{fmtBytes(file.size)}</div>
                {uploading && <ProgressBar indeterminate className="mt-2" />}
              </div>
              {!uploading && <IconButton icon={X} label="Remove file" size="sm" onClick={() => chooseFile(null)} />}
            </div>
          )}

          <div className="mt-4 flex items-center justify-end gap-2">
            <Button variant="primary" leadingIcon={UploadCloud} disabled={!file} loading={uploading} onClick={submit}>
              {uploading ? "Importing…" : "Import file"}
            </Button>
          </div>
        </Card>

        <Card>
          <CardHeader title="Expected format" description="Column names are case-insensitive and can be in any order." />
          <ul className="flex flex-wrap gap-1.5">
            {COLUMNS.map((c) => (
              <li key={c} className="h-6 px-2 rounded-md border border-line bg-panel2 font-mono text-xs text-ink flex items-center">{c}</li>
            ))}
          </ul>
          <p className="text-[13px] text-ink2 mt-4">
            Each row is one punch. Log Date is DD-MM-YYYY plus Hr:Min. Device (Entry/Exit) is stored but not used for
            any calculation yet — a day is simply marked tracked for an employee once it has at least one punch.
          </p>
        </Card>
      </div>

      {result && (
        <motion.section
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: [0, 0, 0, 1] }}
          className="mt-6 flex flex-col gap-4"
          aria-label="Import results"
        >
          <Banner tone={result.rejected.length ? "warn" : "good"} title="Import complete">
            {result.accepted} of {result.row_count} rows were imported across {result.employees_affected} employee{result.employees_affected === 1 ? "" : "s"}.
          </Banner>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard label="Rows in file" icon={Rows3} value={String(result.row_count)} animateValue={result.row_count} />
            <StatCard label="Accepted" icon={CheckCircle2} value={String(result.accepted)} tone="good" animateValue={result.accepted} />
            <StatCard label="Employees affected" icon={Users} value={String(result.employees_affected)} animateValue={result.employees_affected} />
            <StatCard label="Rejected" icon={XCircle} value={String(result.rejected.length)} tone={result.rejected.length ? "crit" : "neutral"} animateValue={result.rejected.length} />
          </div>
          <Card padding="none" className="overflow-hidden">
            <CardHeader divider title="Rejected rows" description={result.rejected.length ? `${result.rejected.length} row(s) couldn't be imported` : undefined} />
            <DataTable
              columns={[
                { key: "row", header: "Row", width: "80px", sortValue: (r) => r.row, cell: (r) => <span className="font-mono text-xs text-ink">{r.row}</span> },
                { key: "reason", header: "Reason", cell: (r) => <span className="text-crit">{r.reason}</span> },
              ]}
              rows={result.rejected}
              getRowKey={(r) => `${r.row}-${r.reason}`}
              empty={<EmptyState icon={CheckCircle2} title="Nothing was rejected" description="Every row imported cleanly." compact />}
            />
          </Card>
        </motion.section>
      )}
    </div>
  );
}
